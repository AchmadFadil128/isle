// SPDX-License-Identifier: GPL-3.0-or-later

//! Small JSON files under the user's data directory, one per feature.

use std::fs;
use std::io::{self, Write};
use std::marker::PhantomData;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use log::{debug, warn};
use serde::Serialize;
use serde::de::DeserializeOwned;

pub struct Store<T> {
    path: PathBuf,
    /// Set when the file exists but could not be read (e.g. permission
    /// denied). Saving would replace data we never saw, so it is skipped.
    read_only: bool,
    /// Set when the file was corrupt and moved aside: the loaded value is a
    /// fresh default, not what the user had.
    fell_back: bool,
    _value: PhantomData<T>,
}

impl<T: Serialize + DeserializeOwned + Default> Store<T> {
    /// A store at `~/.local/share/isle/<name>.json`.
    pub fn new(name: &str) -> Self {
        Self::at(data_dir().join(format!("{name}.json")))
    }

    fn at(path: PathBuf) -> Self {
        Self {
            path,
            read_only: false,
            fell_back: false,
            _value: PhantomData,
        }
    }

    /// Loads the stored value, falling back to the default. A corrupt file is moved aside to
    /// `<name>.json.corrupt`; one that cannot be read or moved turns saving off until restart.
    pub fn load(&mut self) -> T {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return T::default(),
            Err(err) => {
                warn!(
                    "could not read {}: {err}; changes will not be saved, so it is not overwritten",
                    self.path.display()
                );
                self.read_only = true;
                return T::default();
            }
        };
        serde_json::from_slice(&bytes).unwrap_or_else(|err| {
            let backup = self.path.with_extension("json.corrupt");
            self.fell_back = true;
            match fs::rename(&self.path, &backup) {
                Ok(()) => warn!(
                    "{} is invalid ({err}); moved to {}",
                    self.path.display(),
                    backup.display()
                ),
                Err(rename_err) => {
                    warn!(
                        "{} is invalid ({err}) and could not be moved aside ({rename_err}); \
                         changes will not be saved, so it is not overwritten",
                        self.path.display()
                    );
                    self.read_only = true;
                }
            }
            T::default()
        })
    }

    /// Whether the value stands in for unreadable or corrupt data, so files it no longer
    /// mentions may still belong to the user's real data.
    pub fn lost_track(&self) -> bool {
        self.read_only || self.fell_back
    }

    /// Saves atomically, so a crash mid-write never leaves a truncated file.
    pub fn save(&self, value: &T) {
        if self.read_only {
            debug!("not saving {}: it could not be loaded", self.path.display());
            return;
        }
        if let Err(err) = write_atomic(&self.path, value) {
            warn!("could not save {}: {err}", self.path.display());
        }
    }
}

/// Creates `dir` (and its parents) readable by the user alone: the clipboard
/// history can hold things worth keeping private.
pub fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    // Created by an older version with the default mode.
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

/// Writes a file only the user can read.
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    private_file(path)?.write_all(bytes)
}

fn private_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
}

fn write_atomic(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        create_private_dir(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    let mut file = private_file(&temp)?;
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

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    /// A fresh, empty directory for one test.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("isle-store-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn corrupt_files_are_moved_aside() {
        let dir = scratch("corrupt");
        let path = dir.join("list.json");
        fs::write(&path, "{ not json").unwrap();

        let mut store = Store::<Vec<u32>>::at(path.clone());
        assert_eq!(store.load(), Vec::<u32>::new());
        assert_eq!(
            fs::read_to_string(dir.join("list.json.corrupt")).unwrap(),
            "{ not json"
        );
        store.save(&vec![1]);
        assert_eq!(store.load(), [1]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn unreadable_files_are_never_overwritten() {
        let dir = scratch("unreadable");
        let path = dir.join("list.json");
        fs::write(&path, "[1, 2]").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o200)).unwrap();
        // Root reads anything, so there is nothing to test then.
        if fs::read(&path).is_ok() {
            fs::remove_dir_all(dir).unwrap();
            return;
        }

        let mut store = Store::<Vec<u32>>::at(path.clone());
        assert_eq!(store.load(), Vec::<u32>::new());
        store.save(&vec![3]);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "[1, 2]");
        fs::remove_dir_all(dir).unwrap();
    }
}
