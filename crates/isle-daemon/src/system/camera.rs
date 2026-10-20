// SPDX-License-Identifier: GPL-3.0-or-later

//! Whether a camera is in use, for the island's privacy indicator.
//!
//! The kernel reports every open and close of `/dev/video*` through inotify,
//! so this costs nothing while nobody touches a camera. Opens minus closes
//! gives the number of handles held. Short-lived probes (udev, PipeWire
//! enumerating devices) open and close a camera within a blink, so a change
//! only counts once it has lasted [`SETTLE`].

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use inotify::{EventMask, Inotify, WatchDescriptor, WatchMask, Watches};
use log::debug;
use tokio::time::{Instant, sleep_until};
use zbus::object_server::InterfaceRef;

use super::{SystemService, publish};

const DEVICES: &str = "/dev";
const SETTLE: Duration = Duration::from_millis(1500);

pub async fn watch(iface: InterfaceRef<SystemService>) -> anyhow::Result<()> {
    let inotify = Inotify::init()?;
    let mut watches = inotify.watches();
    // Cameras come and go (USB webcams), so watch the directory too.
    let directory = watches.add(DEVICES, WatchMask::CREATE | WatchMask::DELETE)?;
    let mut cameras: HashMap<WatchDescriptor, PathBuf> = HashMap::new();
    for path in camera_paths() {
        add_camera(&mut watches, &mut cameras, path);
    }

    // Handles held right now, e.g. a call already running when isled starts.
    let mut open = cameras.values().map(|path| holders(path)).sum::<usize>();
    let mut published = false;
    let mut settle_at = (open > 0).then(|| Instant::now() + SETTLE);

    let mut events = inotify.into_event_stream([0u8; 1024])?;
    loop {
        tokio::select! {
            event = events.next() => {
                let Some(event) = event else { return Ok(()) };
                let event = event?;
                if event.wd == directory {
                    let Some(name) = event.name.as_ref().and_then(|n| n.to_str()) else { continue };
                    if !name.starts_with("video") {
                        continue;
                    }
                    let path = Path::new(DEVICES).join(name);
                    if event.mask.contains(EventMask::CREATE) {
                        add_camera(&mut watches, &mut cameras, path);
                    }
                    continue;
                }
                if event.mask.contains(EventMask::OPEN) {
                    open += 1;
                } else if event.mask.intersects(EventMask::CLOSE_WRITE | EventMask::CLOSE_NOWRITE) {
                    open = open.saturating_sub(1);
                } else if event.mask.contains(EventMask::IGNORED) {
                    // The device went away; its watch is gone with it.
                    cameras.remove(&event.wd);
                    if cameras.is_empty() {
                        open = 0;
                    }
                }
                if (open > 0) != published {
                    settle_at = Some(Instant::now() + SETTLE);
                }
            }
            () = sleep_until(settle_at.unwrap_or_else(Instant::now)), if settle_at.is_some() => {
                settle_at = None;
                let in_use = open > 0;
                if in_use != published {
                    published = in_use;
                    debug!("camera in use: {in_use}");
                    publish(&iface, |state| state.camera_in_use = in_use, None).await;
                }
            }
        }
    }
}

fn camera_paths() -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(DEVICES) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("video"))
        })
        .collect()
}

fn add_camera(
    watches: &mut Watches,
    cameras: &mut HashMap<WatchDescriptor, PathBuf>,
    path: PathBuf,
) {
    let mask = WatchMask::OPEN | WatchMask::CLOSE_WRITE | WatchMask::CLOSE_NOWRITE;
    match watches.add(&path, mask) {
        Ok(descriptor) => {
            cameras.insert(descriptor, path);
        }
        Err(err) => debug!("cannot watch {}: {err}", path.display()),
    }
}

/// How many open file handles point at `device`, from our own processes'
/// `/proc/*/fd` (others are not readable, and do not affect this user's
/// privacy indicator). Only used once, at start-up.
fn holders(device: &Path) -> usize {
    let Ok(processes) = fs::read_dir("/proc") else {
        return 0;
    };
    processes
        .flatten()
        .filter_map(|process| fs::read_dir(process.path().join("fd")).ok())
        .flat_map(|fds| fds.flatten())
        .filter(|fd| fs::read_link(fd.path()).is_ok_and(|target| target == device))
        .count()
}
