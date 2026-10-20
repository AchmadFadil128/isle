// SPDX-License-Identifier: GPL-3.0-or-later

//! Lyrics from LRCLIB (https://lrclib.net), a free database of synced lyrics,
//! cached on disk so each song is only looked up once.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use isle_core::lrc::{self, LyricLine};
use isle_core::track::search_terms;
use log::debug;
use serde::{Deserialize, Serialize};

use super::art::fnv1a;
use crate::store::cache_dir;

const API: &str = "https://lrclib.net/api";
const TIMEOUT: Duration = Duration::from_secs(10);
const USER_AGENT: &str = concat!(
    "Isle/",
    env!("CARGO_PKG_VERSION"),
    " (Linux dynamic island)"
);
/// How far a search result's length may differ from the track's, in seconds.
const DURATION_TOLERANCE: f64 = 3.0;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LyricsStatus {
    /// No track is playing.
    #[default]
    None,
    Loading,
    /// Lines have times; highlight them as the song plays.
    Synced,
    /// Lines have no times (`time_ms` is -1).
    Plain,
    Instrumental,
    NotFound,
    /// The lookup failed, e.g. while offline. Never cached, and retried
    /// after a growing delay for as long as the track stays current.
    Error,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Lyrics {
    /// Identifies the track these lyrics belong to.
    pub track: String,
    pub status: LyricsStatus,
    pub lines: Vec<LyricLine>,
}

/// What we know about a track for looking up its lyrics.
#[derive(Debug, Clone, PartialEq)]
pub struct TrackQuery {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub length_s: f64,
}

impl TrackQuery {
    pub fn key(&self) -> String {
        format!(
            "{}\u{1f}{}\u{1f}{}\u{1f}{:.0}",
            self.artist, self.title, self.album, self.length_s
        )
    }

    pub fn status(&self, status: LyricsStatus) -> Lyrics {
        Lyrics {
            track: self.key(),
            status,
            lines: Vec::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    synced_lyrics: Option<String>,
    plain_lyrics: Option<String>,
    #[serde(default)]
    instrumental: bool,
    duration: Option<f64>,
}

/// Looks up lyrics, consulting the disk cache first. Blocking.
pub fn fetch(query: &TrackQuery) -> Lyrics {
    let cache = cache_path(query);
    if let Some(cached) = fs::read_to_string(&cache)
        .ok()
        .and_then(|text| serde_json::from_str::<Lyrics>(&text).ok())
    {
        return cached;
    }

    let lyrics = match lookup(query) {
        Ok(Some(record)) => from_record(query, record),
        Ok(None) => query.status(LyricsStatus::NotFound),
        Err(err) => {
            debug!("lyrics lookup failed: {err}");
            return query.status(LyricsStatus::Error);
        }
    };
    // Misses are not cached: the lyrics may be added to LRCLIB later.
    if lyrics.status != LyricsStatus::NotFound {
        if let Some(parent) = cache.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(&lyrics) {
            let _ = fs::write(cache, json);
        }
    }
    lyrics
}

fn lookup(query: &TrackQuery) -> anyhow::Result<Option<Record>> {
    let (title, artist) = search_terms(&query.title, &query.artist);
    if title.is_empty() {
        return Ok(None);
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .user_agent(USER_AGENT)
        .http_status_as_error(false)
        .build()
        .into();

    // An exact match on title, artist, album and duration is the most precise.
    if !artist.is_empty() && query.length_s > 0.0 {
        let mut response = agent
            .get(format!("{API}/get"))
            .query("track_name", &title)
            .query("artist_name", &artist)
            .query("album_name", &query.album)
            .query("duration", format!("{:.0}", query.length_s))
            .call()?;
        match response.status().as_u16() {
            200 => return Ok(Some(response.body_mut().read_json()?)),
            404 => {}
            status => anyhow::bail!("LRCLIB returned HTTP {status}"),
        }
    }

    // Otherwise search, preferring synced lyrics of about the right length.
    let mut request = agent
        .get(format!("{API}/search"))
        .query("track_name", &title);
    if !artist.is_empty() {
        request = request.query("artist_name", &artist);
    }
    let mut response = request.call()?;
    if response.status().as_u16() != 200 {
        anyhow::bail!("LRCLIB returned HTTP {}", response.status());
    }
    let results: Vec<Record> = response.body_mut().read_json()?;
    Ok(best_match(results, query.length_s))
}

fn best_match(results: Vec<Record>, length_s: f64) -> Option<Record> {
    let fits = |record: &Record| {
        length_s <= 0.0
            || record
                .duration
                .is_none_or(|duration| (duration - length_s).abs() <= DURATION_TOLERANCE)
    };
    let score = |record: &Record| {
        (
            fits(record),
            record.synced_lyrics.is_some(),
            record.plain_lyrics.is_some(),
        )
    };
    results
        .into_iter()
        .filter(|record| {
            record.synced_lyrics.is_some() || record.plain_lyrics.is_some() || record.instrumental
        })
        .max_by_key(score)
}

fn from_record(query: &TrackQuery, record: Record) -> Lyrics {
    let synced = record
        .synced_lyrics
        .as_deref()
        .map(lrc::parse)
        .unwrap_or_default();
    let (status, lines) = if !synced.is_empty() {
        (LyricsStatus::Synced, synced)
    } else if let Some(plain) = record
        .plain_lyrics
        .as_deref()
        .filter(|p| !p.trim().is_empty())
    {
        (LyricsStatus::Plain, lrc::plain(plain))
    } else if record.instrumental {
        (LyricsStatus::Instrumental, Vec::new())
    } else {
        (LyricsStatus::NotFound, Vec::new())
    };
    Lyrics {
        track: query.key(),
        status,
        lines,
    }
}

fn cache_path(query: &TrackQuery) -> PathBuf {
    cache_dir()
        .join("lyrics")
        .join(format!("{:016x}.json", fnv1a(&query.key())))
}
