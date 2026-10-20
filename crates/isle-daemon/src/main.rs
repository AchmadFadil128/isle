// SPDX-License-Identifier: GPL-3.0-or-later

//! `isled`: the Isle background service, on the session bus as `io.github.zickrian.isle.Daemon`.
//! See `docs/dbus-api.md` for the interfaces.

mod calendar;
mod clipboard;
mod clock;
mod media;
mod pomodoro;
mod shelf;
mod store;
mod system;
mod todo;

use anyhow::Context;
use log::{info, warn};
use zbus::connection;

use crate::calendar::CalendarService;
use crate::clipboard::ClipboardService;
use crate::media::MediaService;
use crate::pomodoro::PomodoroService;
use crate::shelf::ShelfService;
use crate::system::SystemService;
use crate::todo::TodoService;

const BUS_NAME: &str = "io.github.zickrian.isle.Daemon";
const OBJECT_PATH: &str = "/io/github/zickrian/isle/Daemon";

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    // The clipboard history lives here; keep it from other users, including
    // folders made by older versions.
    if let Err(err) = store::create_private_dir(&store::data_dir()) {
        warn!(
            "could not make {} private: {err}",
            store::data_dir().display()
        );
    }

    let session = connection::Builder::session()?
        .serve_at(OBJECT_PATH, MediaService::default())?
        .serve_at(OBJECT_PATH, PomodoroService::load())?
        .serve_at(OBJECT_PATH, TodoService::load())?
        .serve_at(OBJECT_PATH, ShelfService::load())?
        .serve_at(OBJECT_PATH, ClipboardService::load())?
        .serve_at(OBJECT_PATH, CalendarService::load())?
        .serve_at(OBJECT_PATH, SystemService::default())?
        .build()
        .await
        .context("could not connect to the session bus")?;

    let server = session.object_server();
    let media = server.interface::<_, MediaService>(OBJECT_PATH).await?;
    let pomodoro = server.interface::<_, PomodoroService>(OBJECT_PATH).await?;
    let todo = server.interface::<_, TodoService>(OBJECT_PATH).await?;
    let system = server.interface::<_, SystemService>(OBJECT_PATH).await?;

    let session_for_media = session.clone();
    tokio::spawn(async move {
        if let Err(err) = media::watch(session_for_media, media).await {
            warn!("media monitoring stopped: {err}");
        }
    });
    tokio::spawn(todo::run(todo));

    match zbus::Connection::system().await {
        Ok(bus) => system::spawn_watchers(bus, system),
        Err(err) => warn!("no system bus, so no battery, network or Bluetooth status: {err}"),
    }

    // Claim the name last, so callers never see a half-initialised service.
    session
        .request_name(BUS_NAME)
        .await
        .with_context(|| format!("could not own {BUS_NAME}; is isled already running?"))?;
    info!("isled is running as {BUS_NAME}");
    // Started only now: a restored phase that ran out while isled was down finishes at once,
    // and clients only see its PhaseFinished signal if it comes from the claimed name.
    tokio::spawn(pomodoro::run(pomodoro));

    std::future::pending::<()>().await;
    Ok(())
}
