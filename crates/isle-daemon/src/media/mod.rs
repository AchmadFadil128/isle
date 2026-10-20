// SPDX-License-Identifier: GPL-3.0-or-later

//! Now-playing information and playback control for whichever MPRIS player
//! (Spotify, browsers, mpv, ...) is currently active, plus its lyrics.

mod art;
mod gap;
mod lyrics;
mod mpris;

use log::warn;
use serde::Serialize;
use zbus::zvariant::OwnedObjectPath;
use zbus::{fdo, interface};

pub use self::lyrics::Lyrics;
pub use self::mpris::watch;
use self::mpris::{PlayerProxy, bounded};

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct NowPlaying {
    /// False when no player is running; every other field is then empty.
    pub available: bool,
    /// The player's name for display, e.g. "Spotify".
    pub identity: String,
    /// Desktop file id without ".desktop", for the player's icon.
    pub desktop_entry: String,
    /// "Playing", "Paused" or "Stopped".
    pub status: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Local path of the cover art, or empty while unknown.
    pub art_path: String,
    pub length_us: i64,
    /// Playback position when it was sampled. While playing, the current
    /// position is `position_us + (now - sampled_at_ms) * 1000 * rate`.
    pub position_us: i64,
    pub sampled_at_ms: i64,
    pub rate: f64,
    pub can_go_next: bool,
    pub can_go_previous: bool,
    pub can_play_pause: bool,
    pub can_seek: bool,
}

#[derive(Default)]
pub struct MediaService {
    now_playing: NowPlaying,
    lyrics: Lyrics,
    /// The active player and the id of its current track.
    active: Option<(PlayerProxy<'static>, Option<OwnedObjectPath>)>,
}

impl MediaService {
    /// Sends a command to the active player without waiting for it.
    ///
    /// zbus holds this interface for as long as a method runs, and the media
    /// watcher needs it to publish anything. Awaiting a slow or hung player
    /// here would freeze every media update, so the call runs in a task of
    /// its own, bounded by a timeout, and a failure is only logged; callers
    /// fire and forget these commands anyway.
    fn send<F, Fut>(&self, command: &'static str, call: F) -> fdo::Result<()>
    where
        F: FnOnce(PlayerProxy<'static>, Option<OwnedObjectPath>) -> Fut + Send + 'static,
        Fut: Future<Output = zbus::Result<()>> + Send + 'static,
    {
        let (player, track) = self
            .active
            .clone()
            .ok_or_else(|| fdo::Error::Failed("no media player is running".into()))?;
        let name = player.inner().destination().to_string();
        tokio::spawn(async move {
            if let Err(err) = bounded(call(player, track)).await {
                warn!("{name} did not handle {command}: {err}");
            }
        });
        Ok(())
    }
}

#[interface(name = "io.github.zickrian.isle.Media1")]
impl MediaService {
    fn play_pause(&self) -> fdo::Result<()> {
        self.send(
            "PlayPause",
            |player, _| async move { player.play_pause().await },
        )
    }

    fn next(&self) -> fdo::Result<()> {
        self.send("Next", |player, _| async move { player.next().await })
    }

    fn previous(&self) -> fdo::Result<()> {
        self.send(
            "Previous",
            |player, _| async move { player.previous().await },
        )
    }

    /// Seeks to an absolute position in microseconds.
    fn set_position(&self, position_us: i64) -> fdo::Result<()> {
        let position_us = position_us.max(0);
        self.send("SetPosition", move |player, track| async move {
            match track {
                Some(track) => player.set_position(&track, position_us).await,
                // Without a track id only a relative seek is possible. Measure
                // it from where the player is now: our own sample may be
                // seconds old.
                None => {
                    let current = player.position().await?;
                    player.seek(position_us.saturating_sub(current)).await
                }
            }
        })
    }

    /// Brings the player's window to the front.
    fn raise(&self) -> fdo::Result<()> {
        self.send("Raise", |player, _| async move {
            let app = mpris::AppProxy::builder(player.inner().connection())
                .destination(player.inner().destination().to_owned())?
                .cache_properties(zbus::proxy::CacheProperties::No)
                .build()
                .await?;
            app.raise().await
        })
    }

    /// JSON `NowPlaying`.
    #[zbus(property)]
    fn now_playing(&self) -> String {
        serde_json::to_string(&self.now_playing).unwrap_or_default()
    }

    /// JSON `Lyrics` for the current track.
    #[zbus(property)]
    fn lyrics(&self) -> String {
        serde_json::to_string(&self.lyrics).unwrap_or_default()
    }
}
