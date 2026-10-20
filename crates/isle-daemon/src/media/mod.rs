// SPDX-License-Identifier: GPL-3.0-or-later

//! Now-playing information and playback control for whichever MPRIS player
//! (Spotify, browsers, mpv, ...) is currently active, plus its lyrics.

mod art;
mod lyrics;
mod mpris;

use serde::Serialize;
use zbus::zvariant::OwnedObjectPath;
use zbus::{fdo, interface};

pub use self::lyrics::Lyrics;
use self::mpris::PlayerProxy;
pub use self::mpris::watch;

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
    fn player(&self) -> fdo::Result<&PlayerProxy<'static>> {
        self.active
            .as_ref()
            .map(|(player, _)| player)
            .ok_or_else(|| fdo::Error::Failed("no media player is running".into()))
    }
}

#[interface(name = "io.github.isle.Media1")]
impl MediaService {
    async fn play_pause(&self) -> fdo::Result<()> {
        Ok(self.player()?.play_pause().await?)
    }

    async fn next(&self) -> fdo::Result<()> {
        Ok(self.player()?.next().await?)
    }

    async fn previous(&self) -> fdo::Result<()> {
        Ok(self.player()?.previous().await?)
    }

    /// Seeks to an absolute position in microseconds.
    async fn set_position(&self, position_us: i64) -> fdo::Result<()> {
        let player = self.player()?;
        let track = self.active.as_ref().and_then(|(_, track)| track.as_ref());
        match track {
            Some(track) => Ok(player.set_position(track, position_us.max(0)).await?),
            // Without a track id, a relative seek is the only option.
            None => {
                let offset = position_us - self.now_playing.position_us;
                Ok(player.seek(offset).await?)
            }
        }
    }

    /// Brings the player's window to the front.
    async fn raise(&self) -> fdo::Result<()> {
        let (player, _) = self
            .active
            .as_ref()
            .ok_or_else(|| fdo::Error::Failed("no media player is running".into()))?;
        let app = mpris::AppProxy::builder(player.inner().connection())
            .destination(player.inner().destination().to_owned())?
            .build()
            .await?;
        Ok(app.raise().await?)
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
