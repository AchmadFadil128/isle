// SPDX-License-Identifier: GPL-3.0-or-later

//! Watches every MPRIS player on the session bus and publishes the active one.

use std::collections::HashMap;

use futures_util::StreamExt;
use log::{debug, warn};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use zbus::fdo::{DBusProxy, PropertiesProxy};
use zbus::names::{InterfaceName, OwnedBusName};
use zbus::object_server::InterfaceRef;
use zbus::proxy::CacheProperties;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};
use zbus::{Connection, proxy};

use super::lyrics::{self, Lyrics, LyricsStatus, TrackQuery};
use super::{MediaService, NowPlaying, art};
use crate::clock::now_ms;

const NAME_PREFIX: &str = "org.mpris.MediaPlayer2.";
/// playerctld re-exports other players; listening to it would duplicate them.
const IGNORED: &[&str] = &["org.mpris.MediaPlayer2.playerctld"];
const OBJECT_PATH: &str = "/org/mpris/MediaPlayer2";
const APP_INTERFACE: &str = "org.mpris.MediaPlayer2";
const PLAYER_INTERFACE: &str = "org.mpris.MediaPlayer2.Player";

#[proxy(
    interface = "org.mpris.MediaPlayer2.Player",
    default_path = "/org/mpris/MediaPlayer2",
    gen_blocking = false
)]
pub trait Player {
    fn play_pause(&self) -> zbus::Result<()>;
    fn next(&self) -> zbus::Result<()>;
    fn previous(&self) -> zbus::Result<()>;
    fn seek(&self, offset: i64) -> zbus::Result<()>;
    fn set_position(&self, track_id: &ObjectPath<'_>, position: i64) -> zbus::Result<()>;
    #[zbus(signal)]
    fn seeked(&self, position: i64) -> zbus::Result<()>;
}

#[proxy(
    interface = "org.mpris.MediaPlayer2",
    default_path = "/org/mpris/MediaPlayer2",
    gen_blocking = false
)]
pub trait App {
    fn raise(&self) -> zbus::Result<()>;
}

enum Event {
    /// A player's properties changed or it seeked.
    Player(OwnedBusName),
    /// Remote cover art finished downloading.
    ArtReady,
    Lyrics(Lyrics),
}

/// Everything read from one player's `GetAll`.
#[derive(Debug, Clone, Default, PartialEq)]
struct Snapshot {
    status: String,
    title: String,
    artist: String,
    album: String,
    art_url: String,
    track_id: Option<OwnedObjectPath>,
    length_us: i64,
    position_us: i64,
    sampled_at_ms: i64,
    rate: f64,
    can_go_next: bool,
    can_go_previous: bool,
    can_play_pause: bool,
    can_seek: bool,
}

struct Entry {
    player: PlayerProxy<'static>,
    properties: PropertiesProxy<'static>,
    identity: String,
    desktop_entry: String,
    snapshot: Snapshot,
    /// Order in which players last started playing; the latest one wins.
    started_playing: u64,
    listener: AbortHandle,
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.listener.abort();
    }
}

struct Watcher {
    conn: Connection,
    iface: InterfaceRef<MediaService>,
    players: HashMap<OwnedBusName, Entry>,
    play_counter: u64,
    events: mpsc::UnboundedSender<Event>,
    /// Remote art currently downloading, to avoid starting it twice.
    downloading_art: Option<String>,
    /// The track whose lyrics are loaded or loading.
    lyrics_track: Option<String>,
}

/// Runs forever, keeping `iface` in sync with the active player.
pub async fn watch(conn: Connection, iface: InterfaceRef<MediaService>) -> anyhow::Result<()> {
    let dbus = DBusProxy::new(&conn).await?;
    // Subscribe before listing, so no player can slip in between.
    let mut owners = dbus.receive_name_owner_changed().await?;
    let (events, mut received) = mpsc::unbounded_channel();
    let mut watcher = Watcher {
        conn,
        iface,
        players: HashMap::new(),
        play_counter: 0,
        events,
        downloading_art: None,
        lyrics_track: None,
    };

    for name in dbus.list_names().await? {
        if is_player(name.as_str()) {
            watcher.add(name).await;
        }
    }
    watcher.publish().await;

    loop {
        tokio::select! {
            Some(signal) = owners.next() => {
                let Ok(args) = signal.args() else { continue };
                if !is_player(args.name().as_str()) {
                    continue;
                }
                let name = OwnedBusName::from(args.name().to_owned());
                watcher.players.remove(&name);
                if args.new_owner().is_some() {
                    watcher.add(name).await;
                }
            }
            Some(event) = received.recv() => match event {
                Event::Player(name) => watcher.refresh(&name).await,
                Event::ArtReady => watcher.downloading_art = None,
                Event::Lyrics(lyrics) => {
                    watcher.set_lyrics(lyrics).await;
                    continue;
                }
            },
            else => return Ok(()),
        }
        watcher.publish().await;
    }
}

fn is_player(name: &str) -> bool {
    name.starts_with(NAME_PREFIX) && !IGNORED.contains(&name)
}

impl Watcher {
    async fn add(&mut self, name: OwnedBusName) {
        match self.connect(name.clone()).await {
            Ok(entry) => {
                debug!("found media player {name}");
                self.players.insert(name.clone(), entry);
                self.refresh(&name).await;
            }
            Err(err) => warn!("could not watch media player {name}: {err}"),
        }
    }

    async fn connect(&self, name: OwnedBusName) -> zbus::Result<Entry> {
        let player = PlayerProxy::builder(&self.conn)
            .destination(name.clone())?
            .cache_properties(CacheProperties::No)
            .build()
            .await?;
        let properties = PropertiesProxy::builder(&self.conn)
            .destination(name.clone())?
            .path(OBJECT_PATH)?
            .cache_properties(CacheProperties::No)
            .build()
            .await?;

        let app = properties
            .get_all(InterfaceName::from_static_str_unchecked(APP_INTERFACE))
            .await
            .unwrap_or_default();
        let identity = app
            .get("Identity")
            .and_then(|v| string(v))
            .unwrap_or_default();
        let desktop_entry = app
            .get("DesktopEntry")
            .and_then(|v| string(v))
            .unwrap_or_default();

        let mut changed = properties.receive_properties_changed().await?;
        let mut seeked = player.receive_seeked().await?;
        let events = self.events.clone();
        let listener = tokio::spawn(async move {
            loop {
                tokio::select! {
                    Some(_) = changed.next() => {}
                    Some(_) = seeked.next() => {}
                    else => break,
                }
                if events.send(Event::Player(name.clone())).is_err() {
                    break;
                }
            }
        })
        .abort_handle();

        Ok(Entry {
            player,
            properties,
            identity,
            desktop_entry,
            snapshot: Snapshot::default(),
            started_playing: 0,
            listener,
        })
    }

    async fn refresh(&mut self, name: &OwnedBusName) {
        let Some(entry) = self.players.get_mut(name) else {
            return;
        };
        let all = entry
            .properties
            .get_all(InterfaceName::from_static_str_unchecked(PLAYER_INTERFACE))
            .await;
        let snapshot = match all {
            Ok(all) => snapshot(&all),
            Err(err) => {
                debug!("could not read {name}: {err}");
                return;
            }
        };
        if snapshot.status == "Playing" && entry.snapshot.status != "Playing" {
            self.play_counter += 1;
            entry.started_playing = self.play_counter;
        }
        entry.snapshot = snapshot;
    }

    /// The player that is playing, or else the one that played most recently.
    fn active(&self) -> Option<&Entry> {
        self.players
            .values()
            .max_by_key(|entry| (entry.snapshot.status == "Playing", entry.started_playing))
    }

    async fn publish(&mut self) {
        let (now_playing, active, query) = match self.active() {
            Some(entry) => {
                let s = &entry.snapshot;
                let now_playing = NowPlaying {
                    available: true,
                    identity: entry.identity.clone(),
                    desktop_entry: entry.desktop_entry.clone(),
                    status: s.status.clone(),
                    title: s.title.clone(),
                    artist: s.artist.clone(),
                    album: s.album.clone(),
                    art_path: art::local_path(&s.art_url).unwrap_or_default(),
                    length_us: s.length_us,
                    position_us: s.position_us,
                    sampled_at_ms: s.sampled_at_ms,
                    rate: s.rate,
                    can_go_next: s.can_go_next,
                    can_go_previous: s.can_go_previous,
                    can_play_pause: s.can_play_pause,
                    can_seek: s.can_seek,
                };
                let query = (!s.title.is_empty()).then(|| TrackQuery {
                    title: s.title.clone(),
                    artist: s.artist.clone(),
                    album: s.album.clone(),
                    length_s: s.length_us as f64 / 1e6,
                });
                let art_url = s.art_url.clone();
                let active = (entry.player.clone(), s.track_id.clone());
                if now_playing.art_path.is_empty() && art::is_remote(&art_url) {
                    self.download_art(art_url);
                }
                (now_playing, Some(active), query)
            }
            None => (NowPlaying::default(), None, None),
        };

        self.load_lyrics(query).await;

        let mut service = self.iface.get_mut().await;
        service.active = active;
        if service.now_playing != now_playing {
            service.now_playing = now_playing;
            if let Err(err) = service
                .now_playing_changed(self.iface.signal_emitter())
                .await
            {
                warn!("could not publish now playing: {err}");
            }
        }
    }

    fn download_art(&mut self, url: String) {
        if self.downloading_art.as_ref() == Some(&url) {
            return;
        }
        self.downloading_art = Some(url.clone());
        let events = self.events.clone();
        tokio::task::spawn_blocking(move || {
            if let Err(err) = art::download(&url) {
                debug!("could not download cover art {url}: {err}");
            }
            let _ = events.send(Event::ArtReady);
        });
    }

    /// Starts loading lyrics when the track changes.
    async fn load_lyrics(&mut self, query: Option<TrackQuery>) {
        let key = query.as_ref().map(TrackQuery::key);
        if key == self.lyrics_track {
            return;
        }
        self.lyrics_track = key;
        match query {
            Some(query) => {
                self.set_lyrics(query.status(LyricsStatus::Loading)).await;
                let events = self.events.clone();
                tokio::task::spawn_blocking(move || {
                    let _ = events.send(Event::Lyrics(lyrics::fetch(&query)));
                });
            }
            None => self.set_lyrics(Lyrics::default()).await,
        }
    }

    async fn set_lyrics(&self, lyrics: Lyrics) {
        // Drop results for a track that is no longer playing.
        if lyrics.status != LyricsStatus::None && self.lyrics_track.as_ref() != Some(&lyrics.track)
        {
            return;
        }
        let mut service = self.iface.get_mut().await;
        if service.lyrics != lyrics {
            service.lyrics = lyrics;
            if let Err(err) = service.lyrics_changed(self.iface.signal_emitter()).await {
                warn!("could not publish lyrics: {err}");
            }
        }
    }
}

fn snapshot(all: &HashMap<String, OwnedValue>) -> Snapshot {
    let get = |key: &str| all.get(key).map(|value| &**value);
    let flag = |key: &str| get(key).and_then(boolean).unwrap_or(false);

    let metadata: HashMap<String, &Value> = match get("Metadata") {
        Some(Value::Dict(dict)) => dict
            .iter()
            .filter_map(|(key, value)| Some((string(key)?, unwrap_variant(value))))
            .collect(),
        _ => HashMap::new(),
    };
    let meta = |key: &str| metadata.get(key).copied();

    Snapshot {
        status: get("PlaybackStatus")
            .and_then(string)
            .unwrap_or_else(|| "Stopped".into()),
        title: meta("xesam:title").and_then(string).unwrap_or_default(),
        artist: meta("xesam:artist")
            .map(strings)
            .unwrap_or_default()
            .join(", "),
        album: meta("xesam:album").and_then(string).unwrap_or_default(),
        art_url: meta("mpris:artUrl").and_then(string).unwrap_or_default(),
        track_id: meta("mpris:trackid").and_then(|value| match value {
            Value::ObjectPath(path) => Some(path.clone().into()),
            // Some players send the id as a plain string.
            other => string(other).and_then(|s| OwnedObjectPath::try_from(s).ok()),
        }),
        length_us: meta("mpris:length").and_then(integer).unwrap_or(0),
        position_us: get("Position").and_then(integer).unwrap_or(0),
        sampled_at_ms: now_ms(),
        rate: get("Rate").and_then(float).unwrap_or(1.0),
        can_go_next: flag("CanGoNext"),
        can_go_previous: flag("CanGoPrevious"),
        can_play_pause: flag("CanPause") || flag("CanPlay"),
        can_seek: flag("CanSeek"),
    }
}

fn unwrap_variant<'a>(value: &'a Value<'a>) -> &'a Value<'a> {
    match value {
        Value::Value(inner) => unwrap_variant(inner),
        other => other,
    }
}

fn string(value: &Value<'_>) -> Option<String> {
    match unwrap_variant(value) {
        Value::Str(s) => Some(s.to_string()),
        Value::ObjectPath(path) => Some(path.to_string()),
        _ => None,
    }
}

fn strings(value: &Value<'_>) -> Vec<String> {
    match unwrap_variant(value) {
        Value::Array(array) => array.iter().filter_map(string).collect(),
        other => string(other).into_iter().collect(),
    }
}

fn integer(value: &Value<'_>) -> Option<i64> {
    match unwrap_variant(value) {
        Value::I64(n) => Some(*n),
        Value::U64(n) => i64::try_from(*n).ok(),
        Value::I32(n) => Some(i64::from(*n)),
        Value::U32(n) => Some(i64::from(*n)),
        Value::F64(n) => Some(*n as i64),
        _ => None,
    }
}

fn float(value: &Value<'_>) -> Option<f64> {
    match unwrap_variant(value) {
        Value::F64(n) => Some(*n),
        other => integer(other).map(|n| n as f64),
    }
}

fn boolean(value: &Value<'_>) -> Option<bool> {
    match unwrap_variant(value) {
        Value::Bool(b) => Some(*b),
        _ => None,
    }
}
