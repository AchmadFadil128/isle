// SPDX-License-Identifier: GPL-3.0-or-later

//! Commands the AI asks to run (installing an app, say), once the user pressed Run: each is a systemd unit
//! of its own (the user's, or the system's when it needs root), so it carries on whatever happens to the
//! island, the screen lock or isled. GNOME Shell starts it (so the password dialog, if any, is GNOME's own);
//! isled watches its log until it ends, and finds it again after a restart.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use super::chat::mask_secrets;
use super::check::tail;
use crate::store::{Store, create_private_dir, write_private};

/// A command runs this long at most; then systemd stops it.
pub const MAX_RUN: Duration = Duration::from_secs(30 * 60);
/// How often its log is read while it runs.
const POLL: Duration = Duration::from_millis(400);
/// How often isled asks systemd whether it still runs (a stop, a crash, a logout end it without a word).
const ALIVE_EVERY: u32 = 5;
/// What the AI and the island get of the output, at most.
const MAX_OUTPUT: usize = 4000;
/// The line the wrapper prints last, with the exit code: `\n[isle-exit 0]`.
const EXIT_MARK: &str = "[isle-exit ";
/// Runs the command (in a subshell, so an `exit` in it ends only that), then says how it ended; a
/// command stopped or cut short says nothing.
const WRAPPER: &str = "( eval \"$1\" ); printf '\\n[isle-exit %d]\\n' \"$?\"";

/// Who runs it: the user, or root (the system, after GNOME's password dialog).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    User,
    System,
}

/// A command started, as kept in tasks.json until it ended and was told.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub command: String,
    pub why: String,
    pub scope: Scope,
    pub log: PathBuf,
    /// Milliseconds since 1970.
    pub started: i64,
}

impl Task {
    pub fn unit(&self) -> String {
        format!("isle-run-{}", self.id)
    }

    /// What GNOME Shell runs to start it: `systemd-run` with its log, limits and environment.
    pub fn spawn(&self) -> Vec<String> {
        let mut argv = vec!["systemd-run".to_owned()];
        if self.scope == Scope::User {
            argv.push("--user".into());
        }
        let log = self.log.display();
        argv.extend([
            format!("--unit={}", self.unit()),
            "--collect".into(),
            "--quiet".into(),
            format!("--property=StandardOutput=append:{log}"),
            format!("--property=StandardError=append:{log}"),
            format!("--property=RuntimeMaxSec={}", MAX_RUN.as_secs()),
            "--setenv=DEBIAN_FRONTEND=noninteractive".into(),
            "--setenv=LANG=C.UTF-8".into(),
            format!("--setenv=PATH={}", path()),
        ]);
        if self.scope == Scope::User
            && let Some(home) = dirs::home_dir()
        {
            argv.push(format!("--working-directory={}", home.display()));
        }
        argv.extend([
            "--".into(),
            "bash".into(),
            "-c".into(),
            WRAPPER.into(),
            "isle".into(),
        ]);
        argv.push(self.command.clone());
        argv
    }

    /// What GNOME Shell runs to stop it.
    pub fn stop(&self) -> Vec<String> {
        let mut argv = vec!["systemctl".to_owned()];
        if self.scope == Scope::User {
            argv.push("--user".into());
        }
        argv.extend(["stop".into(), self.unit()]);
        argv
    }
}

/// The PATH a command gets: the system's, and where the user's own programs live (npm, pipx, cargo…).
fn path() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let user = [
        ".local/bin",
        ".npm-global/bin",
        ".cargo/bin",
        ".bun/bin",
        ".volta/bin",
    ]
    .iter()
    .map(|dir| home.join(dir).display().to_string());
    user.chain(
        [
            "/usr/local/sbin",
            "/usr/local/bin",
            "/usr/sbin",
            "/usr/bin",
            "/sbin",
            "/bin",
            "/snap/bin",
        ]
        .iter()
        .map(|dir| (*dir).to_owned()),
    )
    .collect::<Vec<_>>()
    .join(":")
}

/// How a command ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ended {
    Exited(i32),
    /// Stopped (Stop, the time limit) or cut short (a logout, a crash) before it could say.
    Stopped,
}

/// What a command reports as it runs: its output so far (the end of it, secrets hidden), how long, and
/// once over how it ended.
#[derive(Debug, Clone)]
pub struct Progress {
    pub output: String,
    pub seconds: f64,
    pub ended: Option<Ended>,
}

/// Where logs go: Isle's cache, which outlives a logout, so a command run as root that carried on
/// meanwhile is still told right at the next login. Each is deleted once told.
fn logs() -> PathBuf {
    crate::store::cache_dir().join("runs")
}

/// A new task for `command`, its log made ready (private to the user; root may still append to it).
pub fn prepare(command: &str, why: &str, scope: Scope) -> std::io::Result<Task> {
    // The time, and a count: two in the same millisecond still differ.
    static COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let count = COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let id = format!("{:x}-{count}", super::chat::now_ms());
    let dir = logs();
    create_private_dir(&dir)?;
    let log = dir.join(format!("run-{id}.log"));
    write_private(&log, b"")?;
    Ok(Task {
        id,
        command: command.to_owned(),
        why: why.to_owned(),
        scope,
        log,
        started: super::chat::now_ms(),
    })
}

/// Follows `task` until it ends, sending its progress as it goes; returns how it ended and its output.
pub async fn follow(task: &Task, progress: impl Fn(Progress)) -> (Ended, String) {
    let started = std::time::Instant::now();
    let mut output = String::new();
    let mut read = 0u64;
    let mut rounds = 0u32;
    loop {
        if let Ok(text) = read_from(&task.log, &mut read).await
            && !text.is_empty()
        {
            output.push_str(&text);
            // Only the end is kept: a long install prints megabytes.
            if output.len() > 4 * MAX_OUTPUT {
                output = tail(&output, 2 * MAX_OUTPUT);
            }
        }
        if let Some(code) = exit_code(&output) {
            let shown = shown(&output);
            progress(Progress {
                output: shown.clone(),
                seconds: started.elapsed().as_secs_f64(),
                ended: Some(Ended::Exited(code)),
            });
            return (Ended::Exited(code), shown);
        }
        rounds += 1;
        // Gone without a word: stopped, or cut short. Its last lines may still be on their way.
        if rounds % ALIVE_EVERY == 0 && !running(task).await {
            tokio::time::sleep(POLL).await;
            if let Ok(text) = read_from(&task.log, &mut read).await {
                output.push_str(&text);
            }
            let shown = shown(&output);
            let ended = exit_code(&output).map_or(Ended::Stopped, Ended::Exited);
            progress(Progress {
                output: shown.clone(),
                seconds: started.elapsed().as_secs_f64(),
                ended: Some(ended.clone()),
            });
            return (ended, shown);
        }
        progress(Progress {
            output: shown(&output),
            seconds: started.elapsed().as_secs_f64(),
            ended: None,
        });
        tokio::time::sleep(POLL).await;
    }
}

/// The output as shown: without the wrapper's last line, the end of it, secrets hidden.
fn shown(output: &str) -> String {
    let body = match output.rfind(EXIT_MARK) {
        Some(at) => &output[..at],
        None => output,
    };
    tail(&mask_secrets(body), MAX_OUTPUT)
}

fn exit_code(output: &str) -> Option<i32> {
    let at = output.rfind(EXIT_MARK)?;
    output[at + EXIT_MARK.len()..]
        .split(']')
        .next()?
        .trim()
        .parse()
        .ok()
}

async fn read_from(path: &Path, offset: &mut u64) -> std::io::Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(*offset)).await?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).await?;
    *offset += bytes.len() as u64;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Whether systemd still runs the task's unit.
async fn running(task: &Task) -> bool {
    let mut command = tokio::process::Command::new("systemctl");
    if task.scope == Scope::User {
        command.arg("--user");
    }
    command.args(["is-active", "--quiet", &task.unit()]);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // systemctl missing (no systemd): the log alone says when it is over.
    command
        .status()
        .await
        .map_or(true, |status| status.success())
}

/// Tasks started and not yet told, kept so isled finds them again after a restart.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Running {
    pub tasks: Vec<Task>,
}

pub fn store() -> Store<Running> {
    Store::new("tasks")
}

/// What became of a task while isled was not watching: how it ended and its output, or `None` if it
/// still runs (then it is followed again).
pub async fn settled(task: &Task) -> Option<(Ended, String)> {
    let mut read = 0;
    let output = read_from(&task.log, &mut read).await.unwrap_or_default();
    if let Some(code) = exit_code(&output) {
        return Some((Ended::Exited(code), shown(&output)));
    }
    if running(task).await {
        return None;
    }
    Some((Ended::Stopped, shown(&output)))
}

/// Deletes a task's log once it has been told.
pub fn clean(task: &Task) {
    std::fs::remove_file(&task.log).ok();
}

/// What a command may do that the user should know before running it, most telling first: removing
/// things, running a script from the web, needing the password.
pub fn risks(command: &str, root: bool) -> Vec<&'static str> {
    let lower = command.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| c.is_whitespace() || c == ';' || c == '&' || c == '|')
        .filter(|w| !w.is_empty())
        .collect();
    let has = |w: &str| words.contains(&w);
    let mut risks = Vec::new();
    let removes = has("rm")
        || has("rmdir")
        || has("purge")
        || has("autoremove")
        || has("uninstall")
        || (has("remove")
            && (has("apt")
                || has("apt-get")
                || has("dnf")
                || has("snap")
                || has("zypper")
                || has("flatpak")))
        || words.iter().any(|w| w.starts_with("-r") && has("pacman"));
    if removes {
        risks.push("removes");
    }
    let fetches = has("curl") || has("wget");
    let runs = lower.contains("| sh")
        || lower.contains("| bash")
        || lower.contains("|sh")
        || lower.contains("|bash")
        || lower.contains("bash <(")
        || lower.contains("sh <(")
        || lower.contains("bash -c \"$(")
        || lower.contains("sh -c \"$(");
    if fetches && runs {
        risks.push("internet");
    }
    if root {
        risks.push("root");
    }
    risks
}

/// Why `command` will not even be offered: it could wreck the system or the user's files.
pub fn refused(command: &str) -> Option<&'static str> {
    let lower = command.to_lowercase();
    // Each command of a line on its own (`a && b; c | d`), without a sudo in front.
    for part in lower.split(['&', ';', '|', '\n']) {
        let words: Vec<&str> = part
            .split_whitespace()
            .skip_while(|w| matches!(*w, "sudo" | "pkexec" | "-e"))
            .collect();
        let Some((program, args)) = words.split_first() else {
            continue;
        };
        let flags: String = args
            .iter()
            .filter(|a| a.starts_with('-') && !a.starts_with("--"))
            .flat_map(|a| a.chars())
            .collect();
        let targets: Vec<&&str> = args.iter().filter(|a| !a.starts_with('-')).collect();
        let everything = |t: &&&str| {
            matches!(
                **t,
                "/" | "/*"
                    | "~"
                    | "~/"
                    | "~/*"
                    | "$home"
                    | "$home/"
                    | "$home/*"
                    | "/home"
                    | "/home/*"
                    | "/usr"
                    | "/etc"
                    | "/boot"
            )
        };
        if *program == "rm"
            && flags.contains('r')
            && (targets.iter().any(everything) || args.contains(&"--no-preserve-root"))
        {
            return Some("it would delete the whole system or home folder");
        }
        if program.starts_with("mkfs") || program.starts_with("wipefs") {
            return Some("it would erase a disk");
        }
        if *program == "dd" && args.iter().any(|a| a.starts_with("of=/dev/")) {
            return Some("it would erase a disk");
        }
        if matches!(*program, "chmod" | "chown")
            && flags.contains('r')
            && targets
                .iter()
                .any(|t| matches!(**t, "/" | "/usr" | "/etc" | "/bin"))
        {
            return Some("it would break the system's permissions");
        }
    }
    if lower.contains(":(){") || lower.contains(":() {") {
        return Some("it would freeze the computer");
    }
    if lower.contains("> /dev/sd")
        || lower.contains(">/dev/sd")
        || lower.contains("> /dev/nvme")
        || lower.contains(">/dev/nvme")
    {
        return Some("it would erase a disk");
    }
    None
}

/// `command` as the AI may write it, with `sudo` (or pkexec) at its start: the command without it, and
/// whether it needs root.
pub fn without_sudo(command: &str, root: bool) -> (String, bool) {
    let trimmed = command.trim();
    for prefix in ["sudo -E ", "sudo ", "pkexec "] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return (rest.trim().to_owned(), true);
        }
    }
    // `sudo` further in (`apt update && sudo apt install x`): the whole line runs as root, each sudo dropped.
    if trimmed.contains("sudo ") {
        return (trimmed.replace("sudo -E ", "").replace("sudo ", ""), true);
    }
    (trimmed.to_owned(), root)
}

/// The card the island shows for a task: JSON for the extension.
pub fn card(
    task: &Task,
    detail: &str,
    risks: &[&str],
    status: &str,
    progress: Option<&Progress>,
) -> Value {
    let (output, seconds, exit) = match progress {
        Some(p) => (
            p.output.as_str(),
            p.seconds,
            match p.ended {
                Some(Ended::Exited(code)) => Some(code),
                _ => None,
            },
        ),
        None => ("", 0.0, None),
    };
    json!({
        "id": task.id,
        "command": if task.scope == Scope::System { format!("sudo {}", task.command) } else { task.command.clone() },
        "why": task.why,
        "detail": detail,
        "risks": risks,
        "status": status,
        "output": output,
        "seconds": seconds,
        "exit": exit,
        "stop": task.stop(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sees_what_a_command_may_do() {
        assert_eq!(risks("apt install -y libreoffice", true), ["root"]);
        assert_eq!(
            risks("curl -fsSL https://ollama.com/install.sh | sh", false),
            ["internet"]
        );
        assert_eq!(
            risks("apt purge -y libreoffice*", true),
            ["removes", "root"]
        );
        assert_eq!(risks("rm -rf ~/Downloads/old", false), ["removes"]);
        assert!(risks("npm install -g @openai/codex", false).is_empty());
        assert!(risks("curl -o x.deb https://example.com/x.deb", false).is_empty());
    }

    #[test]
    fn refuses_what_would_wreck_the_system() {
        for bad in [
            "rm -rf /",
            "sudo rm -rf / --no-preserve-root",
            "rm -rf ~",
            "rm -rf ~/*",
            "mkfs.ext4 /dev/sda1",
            "dd if=/dev/zero of=/dev/sda",
            ":(){ :|:& };:",
            "rm  -rf   /",
        ] {
            assert!(refused(bad).is_some(), "{bad} was offered");
        }
        for fine in [
            "rm -rf ~/Downloads/old",
            "rm -rf /tmp/isle-test",
            "apt install -y vlc",
            "dd if=a.iso of=b.img",
        ] {
            assert!(refused(fine).is_none(), "{fine} was refused");
        }
    }

    #[test]
    fn takes_sudo_off_and_runs_as_root() {
        assert_eq!(
            without_sudo("sudo apt install -y vlc", false),
            ("apt install -y vlc".into(), true)
        );
        assert_eq!(
            without_sudo("apt update && sudo apt install -y vlc", false),
            ("apt update && apt install -y vlc".into(), true)
        );
        assert_eq!(
            without_sudo("npm i -g x", false),
            ("npm i -g x".into(), false)
        );
        assert_eq!(
            without_sudo("apt install x", true),
            ("apt install x".into(), true)
        );
    }

    #[test]
    fn reads_how_it_ended() {
        assert_eq!(exit_code("Setting up vlc ...\n\n[isle-exit 0]\n"), Some(0));
        assert_eq!(
            exit_code("E: Unable to locate package x\n\n[isle-exit 100]\n"),
            Some(100)
        );
        assert_eq!(exit_code("still going"), None);
        assert_eq!(shown("a\nb\n\n[isle-exit 0]\n"), "a\nb");
    }

    #[test]
    fn starts_and_stops_through_systemd() {
        let task = Task {
            id: "abc".into(),
            command: "apt install -y vlc".into(),
            why: "Install VLC".into(),
            scope: Scope::System,
            log: PathBuf::from("/run/user/1000/isle/run-abc.log"),
            started: 0,
        };
        let argv = task.spawn();
        assert_eq!(argv[0], "systemd-run");
        assert!(
            !argv.contains(&"--user".to_owned())
                && argv.contains(&"--unit=isle-run-abc".to_owned())
        );
        assert!(argv.contains(
            &"--property=StandardOutput=append:/run/user/1000/isle/run-abc.log".to_owned()
        ));
        assert_eq!(
            &argv[argv.len() - 5..],
            ["bash", "-c", WRAPPER, "isle", "apt install -y vlc"]
        );
        assert_eq!(task.stop(), ["systemctl", "stop", "isle-run-abc"]);
        let user = Task {
            scope: Scope::User,
            ..task
        };
        assert!(user.spawn().contains(&"--user".to_owned()) && user.stop()[1] == "--user");
    }

    #[tokio::test]
    async fn follows_a_command_to_its_end() {
        // As systemd would, with the wrapper: the log fills, then the exit line.
        let task = prepare("echo hi", "Say hi", Scope::User).unwrap();
        let log = task.log.clone();
        let wrapper = format!("{{ {WRAPPER}; }} >> {} 2>&1", log.display());
        let mut child = tokio::process::Command::new("bash")
            .args([
                "-c",
                &wrapper,
                "isle",
                "echo one; sleep 0.5; echo two; exit 3",
            ])
            .spawn()
            .unwrap();
        let seen = std::sync::Mutex::new(Vec::new());
        let (ended, output) = follow(&task, |p| seen.lock().unwrap().push(p.output)).await;
        child.wait().await.unwrap();
        assert_eq!(ended, Ended::Exited(3));
        assert_eq!(output, "one\ntwo");
        assert!(seen.lock().unwrap().iter().any(|o| o == "one"));
        clean(&task);
        assert!(!log.exists());
    }
}
