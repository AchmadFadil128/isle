// SPDX-License-Identifier: GPL-3.0-or-later

//! AI agent alerts: Claude Code and Codex, once the user turns them on, run `isled --agent-hook` when
//! they need the user or finish, and the island shows it. The hooks live in each AI's own config.

mod claude;
mod codex;
mod file;
pub mod hook;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context;
use futures_util::StreamExt;
use inotify::{EventMask, Inotify, WatchMask};
use log::{debug, warn};
use serde::{Deserialize, Serialize};
use tokio::time::{Instant, sleep_until};
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::{fdo, interface};

use crate::assistant::Provider;

/// Longest texts the island gets, in characters.
const MAX_MESSAGE: usize = 160;
const MAX_PROJECT: usize = 60;
const MAX_SESSION: usize = 100;
const MAX_CWD: usize = 1024;
/// Events of one kind from one AI closer together than this are dropped.
const MIN_GAP: Duration = Duration::from_millis(300);
/// A config file is looked at again once it has been quiet this long.
const SETTLE: Duration = Duration::from_millis(250);

const KINDS: [&str; 3] = ["permission", "waiting", "done"];

/// The AIs whose alerts Isle can show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ai {
    Claude,
    Codex,
}

impl Ai {
    const ALL: [Ai; 2] = [Ai::Claude, Ai::Codex];

    fn id(self) -> &'static str {
        match self {
            Ai::Claude => "claude",
            Ai::Codex => "codex",
        }
    }

    fn from_id(id: &str) -> Option<Ai> {
        Self::ALL.into_iter().find(|ai| ai.id() == id)
    }

    fn name(self) -> &'static str {
        match self {
            Ai::Claude => "Claude Code",
            Ai::Codex => "Codex",
        }
    }

    fn config(self) -> PathBuf {
        match self {
            Ai::Claude => claude::settings_path(),
            Ai::Codex => codex::config_path(),
        }
    }

    fn found(self) -> bool {
        match self {
            Ai::Claude => Provider::Claude.program().is_some(),
            Ai::Codex => Provider::Codex.program().is_some(),
        }
    }

    fn hooked(self) -> bool {
        match self {
            Ai::Claude => claude::hooked(&self.config()),
            Ai::Codex => codex::hooked(&self.config()),
        }
    }

    fn hook(self) -> anyhow::Result<()> {
        let isled = isled_path()?;
        let isled = isled
            .to_str()
            .with_context(|| format!("isled's path {} is not UTF-8", isled.display()))?;
        match self {
            Ai::Claude => claude::install(&self.config(), &claude::command(isled)),
            Ai::Codex => codex::install(&self.config(), isled),
        }
    }

    /// Whether there was a hook to take out.
    fn unhook(self) -> anyhow::Result<bool> {
        match self {
            Ai::Claude => claude::remove(&self.config()),
            Ai::Codex => codex::remove(&self.config()),
        }
    }
}

/// This isled, as hooks run it. Replaced while running (an update), the kernel adds " (deleted)".
fn isled_path() -> anyhow::Result<PathBuf> {
    let exe = std::env::current_exe().context("could not find isled's own path")?;
    let exe = exe
        .to_str()
        .and_then(|path| path.strip_suffix(" (deleted)"))
        .map_or(exe.clone(), PathBuf::from);
    Ok(std::fs::canonicalize(&exe).unwrap_or(exe))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
struct Status {
    found: bool,
    hooked: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
struct Agents {
    claude: Status,
    codex: Status,
}

impl Agents {
    fn read() -> Self {
        let status = |ai: Ai| Status {
            found: ai.found(),
            hooked: ai.hooked(),
        };
        Self {
            claude: status(Ai::Claude),
            codex: status(Ai::Codex),
        }
    }
}

/// What an AI hook reports, and the island shows.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Event {
    pub provider: String,
    pub kind: String,
    pub project: String,
    pub cwd: String,
    pub message: String,
    pub session: String,
}

impl Event {
    /// Checked, on one line each and cut to size: the project is the folder's name unless given.
    pub fn checked(mut self) -> Result<Self, String> {
        if Ai::from_id(&self.provider).is_none() {
            return Err(format!("unknown provider `{}`", cut(&self.provider, 40)));
        }
        if !KINDS.contains(&self.kind.as_str()) {
            return Err(format!("unknown kind `{}`", cut(&self.kind, 40)));
        }
        let cwd = self.cwd.trim();
        self.cwd = if cwd.starts_with('/')
            && cwd.chars().count() <= MAX_CWD
            && !cwd.contains(char::is_control)
        {
            cwd.to_owned()
        } else {
            String::new()
        };
        if self.project.trim().is_empty() {
            self.project = Path::new(&self.cwd)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
        }
        self.project = cut(&self.project, MAX_PROJECT);
        self.message = cut(&self.message, MAX_MESSAGE);
        self.session = cut(&self.session, MAX_SESSION);
        Ok(self)
    }
}

/// `text` on one line, its spaces collapsed, at most `max` characters (an ellipsis ends a cut one).
fn cut(text: &str, max: usize) -> String {
    let words: Vec<String> = text
        .split_whitespace()
        .map(|word| word.chars().filter(|c| !c.is_control()).collect())
        .filter(|word: &String| !word.is_empty())
        .collect();
    let line = words.join(" ");
    if line.chars().count() <= max {
        return line;
    }
    let mut short: String = line.chars().take(max.saturating_sub(1)).collect();
    short.truncate(short.trim_end().len());
    short.push('…');
    short
}

/// Drops an event that follows the last of its kind from the same AI too closely.
#[derive(Default)]
struct Limiter {
    last: HashMap<(String, String), Instant>,
}

impl Limiter {
    fn allow(&mut self, event: &Event, now: Instant) -> bool {
        let key = (event.provider.clone(), event.kind.clone());
        if self
            .last
            .get(&key)
            .is_some_and(|at| now.duration_since(*at) < MIN_GAP)
        {
            return false;
        }
        self.last.insert(key, now);
        true
    }
}

#[derive(Default)]
pub struct AgentsService {
    limiter: Limiter,
}

#[interface(name = "io.github.zickrian.isle.Agents1")]
impl AgentsService {
    /// Puts Isle's hook in `provider`'s config, or takes it out. GNOME Shell's to ask, no other program's.
    async fn set_hooked(
        &mut self,
        provider: &str,
        on: bool,
        #[zbus(connection)] connection: &zbus::Connection,
        #[zbus(header)] header: zbus::message::Header<'_>,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        crate::caller::shell_only(connection, &header).await?;
        let ai = Ai::from_id(provider)
            .ok_or_else(|| fdo::Error::InvalidArgs(format!("no AI called `{provider}`")))?;
        let done =
            tokio::task::spawn_blocking(move || if on { ai.hook() } else { ai.unhook().map(drop) })
                .await
                .map_err(|err| fdo::Error::Failed(err.to_string()))?;
        if let Err(err) = self.agents_changed(&emitter).await {
            warn!("could not publish the AI alerts: {err}");
        }
        done.map_err(|err| fdo::Error::Failed(format!("{err:#}")))
    }

    /// From `isled --agent-hook`: JSON `{provider, kind, project, cwd, message, session}`.
    async fn report(
        &mut self,
        json: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        let event: Event =
            serde_json::from_str(json).map_err(|err| fdo::Error::InvalidArgs(err.to_string()))?;
        let event = event.checked().map_err(fdo::Error::InvalidArgs)?;
        if !self.limiter.allow(&event, Instant::now()) {
            debug!(
                "dropped a {} {} event: too soon",
                event.provider, event.kind
            );
            return Ok(());
        }
        let json = serde_json::to_string(&event).unwrap_or_default();
        Ok(Self::event(&emitter, &json).await?)
    }

    /// JSON `{claude: {found, hooked}, codex: {found, hooked}}`, read afresh.
    #[zbus(property)]
    fn agents(&self) -> String {
        serde_json::to_string(&Agents::read()).unwrap_or_default()
    }

    #[zbus(signal)]
    async fn event(emitter: &SignalEmitter<'_>, json: &str) -> zbus::Result<()>;
}

/// Publishes `Agents` again whenever an AI's config file changes (the user, or the AI, edited it).
pub async fn watch(iface: InterfaceRef<AgentsService>) {
    let mut published = Agents::read();
    loop {
        if let Err(err) = watch_configs(&iface, &mut published).await {
            debug!("stopped watching the AIs' configs: {err}");
            return;
        }
    }
}

/// Returns when a config folder came or went, to watch afresh.
async fn watch_configs(
    iface: &InterfaceRef<AgentsService>,
    published: &mut Agents,
) -> anyhow::Result<()> {
    let inotify = Inotify::init()?;
    let mut watches = inotify.watches();
    let files: Vec<PathBuf> = Ai::ALL.into_iter().map(Ai::config).collect();
    let mut watched = false;
    for file in &files {
        let Some(dir) = file.parent() else { continue };
        let changes = WatchMask::CLOSE_WRITE
            | WatchMask::MOVED_TO
            | WatchMask::MOVED_FROM
            | WatchMask::CREATE
            | WatchMask::DELETE
            | WatchMask::DELETE_SELF
            | WatchMask::MOVE_SELF;
        if watches.add(dir, changes).is_ok() {
            watched = true;
        } else if let Some(parent) = dir.parent()
            && watches
                .add(parent, WatchMask::CREATE | WatchMask::MOVED_TO)
                .is_ok()
        {
            // The folder appearing (the AI's first run).
            watched = true;
        }
    }
    if !watched {
        std::future::pending::<()>().await;
    }
    let names: Vec<&std::ffi::OsStr> = files
        .iter()
        .flat_map(|file| [file.file_name(), file.parent().and_then(Path::file_name)])
        .flatten()
        .collect();
    let mut events = inotify.into_event_stream([0u8; 1024])?;
    let mut due = None;
    let mut again = false;
    loop {
        tokio::select! {
            event = events.next() => {
                let event = event.context("inotify stopped")??;
                let gone = EventMask::DELETE_SELF | EventMask::MOVE_SELF | EventMask::IGNORED | EventMask::Q_OVERFLOW;
                let named = event.name.as_deref().is_some_and(|name| names.contains(&name));
                if event.mask.intersects(gone) || (named && event.mask.contains(EventMask::ISDIR)) {
                    again = true;
                } else if !named {
                    continue;
                }
                due = Some(Instant::now() + SETTLE);
            }
            () = sleep_until(due.unwrap_or_else(Instant::now)), if due.is_some() => {
                due = None;
                let now = Agents::read();
                if now != *published {
                    *published = now;
                    let service = iface.get().await;
                    if let Err(err) = service.agents_changed(iface.signal_emitter()).await {
                        warn!("could not publish the AI alerts: {err}");
                    }
                }
                if again {
                    return Ok(());
                }
            }
        }
    }
}

/// For `isled --doctor`: whether each AI's alerts are on.
pub fn report() -> String {
    let lines: Vec<String> = Ai::ALL
        .into_iter()
        .map(|ai| {
            let state = match (ai.found(), ai.hooked()) {
                (_, true) => format!("on ({})", ai.config().display()),
                (true, false) => "off".to_owned(),
                (false, false) => "off (not installed)".to_owned(),
            };
            format!("  {}: {state}", ai.name())
        })
        .collect();
    lines.join("\n")
}

/// `isled --unhook-all`: takes Isle's hooks out of every AI's config, as Isle is uninstalled.
pub fn unhook_all() {
    for ai in Ai::ALL {
        let name = ai.name();
        match ai.unhook() {
            Ok(true) => println!("{name}: alerts removed from {}", ai.config().display()),
            Ok(false) => println!("{name}: no alerts were set up"),
            Err(err) => println!("{name}: could not remove the alerts: {err:#}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(json: &str) -> Result<Event, String> {
        serde_json::from_str::<Event>(json).unwrap().checked()
    }

    #[test]
    fn events_are_checked_and_cut_to_size() {
        let checked = event(
            r#"{"provider": "claude", "kind": "permission", "cwd": "/home/a/isle",
                "message": "  Claude needs\n your permission\tto use Bash  ", "session": "abc"}"#,
        )
        .unwrap();
        assert_eq!(checked.project, "isle");
        assert_eq!(checked.message, "Claude needs your permission to use Bash");
        assert_eq!(checked.session, "abc");

        let long = event(&format!(
            r#"{{"provider": "codex", "kind": "done", "cwd": "relative/path",
                 "project": "{}", "message": "{}\u0007"}}"#,
            "p".repeat(100),
            "word ".repeat(100)
        ))
        .unwrap();
        assert_eq!(long.cwd, "");
        assert_eq!(long.project.chars().count(), MAX_PROJECT);
        assert!(long.project.ends_with('…'));
        assert!(long.message.chars().count() <= MAX_MESSAGE);
        assert!(long.message.ends_with("word…"));

        assert!(event(r#"{"provider": "agy", "kind": "done"}"#).is_err());
        assert!(event(r#"{"provider": "claude", "kind": "exploded"}"#).is_err());
        assert!(event(r#"{"provider": "claude", "kind": "done"}"#).is_ok());
    }

    #[test]
    fn events_too_close_together_are_dropped() {
        let mut limiter = Limiter::default();
        let done = event(r#"{"provider": "claude", "kind": "done"}"#).unwrap();
        let waiting = event(r#"{"provider": "claude", "kind": "waiting"}"#).unwrap();
        let codex = event(r#"{"provider": "codex", "kind": "done"}"#).unwrap();
        let start = Instant::now();
        assert!(limiter.allow(&done, start));
        assert!(!limiter.allow(&done, start + Duration::from_millis(100)));
        assert!(limiter.allow(&waiting, start + Duration::from_millis(100)));
        assert!(limiter.allow(&codex, start + Duration::from_millis(100)));
        assert!(limiter.allow(&done, start + Duration::from_millis(400)));
    }

    #[test]
    fn agents_are_published_as_json() {
        let agents = Agents {
            claude: Status {
                found: true,
                hooked: false,
            },
            codex: Status::default(),
        };
        assert_eq!(
            serde_json::to_string(&agents).unwrap(),
            r#"{"claude":{"found":true,"hooked":false},"codex":{"found":false,"hooked":false}}"#
        );
    }
}
