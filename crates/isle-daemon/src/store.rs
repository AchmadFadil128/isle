// SPDX-License-Identifier: GPL-3.0-or-later

//! Small JSON files under the user's data directory, one per feature.

use std::fs;
use std::io::Write;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};

use log::warn;
use serde::Serialize;
use serde::de::DeserializeOwned;

pub struct Store<T> {
    path: PathBuf,
    _value: PhantomData<T>,
}

impl<T: Serialize + DeserializeOwned + Default> Store<T> {
    /// A store at `~/.local/share/isle/<name>.json`.
    pub fn new(name: &str) -> Self {
        Self {
            path: data_dir().join(format!("{name}.json")),
            _value: PhantomData,
        }
    }

    /// Loads the stored value, falling back to the default if the file is
    /// missing or unreadable. A corrupt file is kept aside rather than lost.
    pub fn load(&self) -> T {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return T::default(),
            Err(err) => {
                warn!("could not read {}: {err}", self.path.display());
                return T::default();
            }
        };
        serde_json::from_str(&text).unwrap_or_else(|err| {
            let backup = self.path.with_extension("json.corrupt");
            warn!(
                "{} is invalid ({err}); moved to {}",
                self.path.display(),
                backup.display()
            );
            let _ = fs::rename(&self.path, backup);
            T::default()
        })
    }

    /// Saves atomically, so a crash mid-write never leaves a truncated file.
    pub fn save(&self, value: &T) {
        if let Err(err) = write_atomic(&self.path, value) {
            warn!("could not save {}: {err}", self.path.display());
        }
    }
}

fn write_atomic(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temp)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(temp, path)?;
    // Flush the rename itself too, so the new file survives a power cut.
    if let Some(parent) = path.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

pub fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("isle")
}

pub fn cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("isle")
}
