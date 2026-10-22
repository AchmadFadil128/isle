// SPDX-License-Identifier: GPL-3.0-or-later

//! `isled`: the Isle background service, on the session bus as `io.github.zickrian.isle.Daemon`.
//! See `docs/dbus-api.md` for the interfaces.

mod assistant;
mod calendar;
mod clipboard;
mod clock;
mod media;
mod pomodoro;
mod reminders;
mod shelf;
mod store;
mod system;
mod todo;
mod usage;

use anyhow::{Context, bail};
use futures_util::StreamExt;
use log::{info, warn};
use zbus::connection;
use zbus::fdo::{DBusProxy, RequestNameFlags, RequestNameReply};

use crate::assistant::AssistantService;
use crate::calendar::CalendarService;
use crate::clipboard::ClipboardService;
use crate::media::MediaService;
use crate::pomodoro::PomodoroService;
use crate::reminders::RemindersService;
use crate::shelf::ShelfService;
use crate::system::SystemService;
use crate::todo::TodoService;
use crate::usage::UsageService;

const BUS_NAME: &str = "io.github.zickrian.isle.Daemon";
const OBJECT_PATH: &str = "/io/github/zickrian/isle/Daemon";
/// Songs whose cover and lyrics stay cached.
const CACHED_SONGS: usize = 500;

const HELP: &str = "isled: the Isle background service (started by systemd or D-Bus, not by hand)

Usage: isled [--version | --doctor | --help]
  --version  print the version
  --doctor   check the service, speech recognition and each AI's install and sign-in
  --help     print this";

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    match std::env::args().nth(1).as_deref() {
        None => {}
        Some("--version" | "-V") => {
            println!("isled {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        Some("--help" | "-h") => {
            println!("{HELP}");
            return Ok(());
        }
        Some("--doctor") => {
            doctor().await;
            return Ok(());
        }
        Some(other) => bail!("unknown option {other}; see isled --help"),
    }
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    // A second isled (started by hand) leaves the running one alone, before it opens or prunes anything.
    if running().await {
        bail!("isled is already running");
    }
    // The clipboard history lives here; keep it from other users, including
    // folders made by older versions.
    if let Err(err) = store::create_private_dir(&store::data_dir()) {
        warn!(
            "could not make {} private: {err}",
            store::data_dir().display()
        );
    }

    // One cover and one lyrics file per song: only the latest few hundred are kept.
    tokio::task::spawn_blocking(|| {
        for kind in ["art", "lyrics"] {
            store::prune_newest(&store::cache_dir().join(kind), CACHED_SONGS);
        }
    });
    let (assistant, assistant_commands) = AssistantService::new();
    let (usage, usage_refresh) = UsageService::new();
    let session = connection::Builder::session()?
        .serve_at(OBJECT_PATH, MediaService::default())?
        .serve_at(OBJECT_PATH, PomodoroService::load())?
        .serve_at(OBJECT_PATH, TodoService::load())?
        .serve_at(OBJECT_PATH, ShelfService::load())?
        .serve_at(OBJECT_PATH, ClipboardService::load())?
        .serve_at(OBJECT_PATH, CalendarService::load())?
        .serve_at(OBJECT_PATH, RemindersService::load())?
        .serve_at(OBJECT_PATH, SystemService::default())?
        .serve_at(OBJECT_PATH, assistant)?
        .serve_at(OBJECT_PATH, usage)?
        .build()
        .await
        .context("could not connect to the session bus")?;

    let server = session.object_server();
    let media = server.interface::<_, MediaService>(OBJECT_PATH).await?;
    let pomodoro = server.interface::<_, PomodoroService>(OBJECT_PATH).await?;
    let todo = server.interface::<_, TodoService>(OBJECT_PATH).await?;
    let system = server.interface::<_, SystemService>(OBJECT_PATH).await?;
    let assistant = server.interface::<_, AssistantService>(OBJECT_PATH).await?;
    let usage = server.interface::<_, UsageService>(OBJECT_PATH).await?;
    tokio::spawn(usage::run(usage, usage_refresh));
    let own_data = assistant::Sources {
        todo: todo.clone(),
        calendar: server.interface::<_, CalendarService>(OBJECT_PATH).await?,
        reminders: server.interface::<_, RemindersService>(OBJECT_PATH).await?,
    };

    let session_for_media = session.clone();
    tokio::spawn(async move {
        if let Err(err) = media::watch(session_for_media, media).await {
            warn!("media monitoring stopped: {err}");
        }
    });
    tokio::spawn(todo::run(todo));
    tokio::spawn(assistant::run(assistant, own_data, assistant_commands));

    match zbus::Connection::system().await {
        Ok(bus) => system::spawn_watchers(bus, system),
        Err(err) => warn!("no system bus, so no battery, network or Bluetooth status: {err}"),
    }

    // Claim the name last, so callers never see a half-initialised service; never taking it from another.
    let claimed = session
        .request_name_with_flags(BUS_NAME, RequestNameFlags::DoNotQueue.into())
        .await
        .with_context(|| format!("could not own {BUS_NAME}"))?;
    if claimed != RequestNameReply::PrimaryOwner {
        bail!("isled is already running");
    }
    info!("isled is running as {BUS_NAME}");
    // Started only now: a restored phase that ran out while isled was down finishes at once,
    // and clients only see its PhaseFinished signal if it comes from the claimed name.
    tokio::spawn(pomodoro::run(pomodoro));

    // Runs until the session bus goes (the session ended) or the name is lost; never outlives its
    // session, which would leave it polling with nobody to tell.
    let lost = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender("org.freedesktop.DBus")?
        .interface("org.freedesktop.DBus")?
        .member("NameLost")?
        .build();
    let mut events = zbus::MessageStream::for_match_rule(lost, &session, None).await?;
    match events.next().await {
        Some(Ok(_)) => info!("lost {BUS_NAME}; stopping"),
        Some(Err(err)) => info!("the session bus went away ({err}); stopping"),
        None => info!("the session bus went away; stopping"),
    }
    Ok(())
}

/// Whether an isled already owns the name on this session's bus.
async fn running() -> bool {
    let Ok(bus) = zbus::Connection::session().await else {
        return false;
    };
    let Ok(dbus) = DBusProxy::new(&bus).await else {
        return false;
    };
    match BUS_NAME.try_into() {
        Ok(name) => dbus.name_has_owner(name).await.unwrap_or(false),
        Err(_) => false,
    }
}

/// `isled --doctor`: what works and what to do about what does not.
async fn doctor() {
    println!("isled {}", env!("CARGO_PKG_VERSION"));
    println!(
        "Service: {}",
        if running().await {
            "running"
        } else {
            "not running (systemctl --user restart isled)"
        }
    );
    println!("Voice assistant:\n{}", assistant::report());
}
