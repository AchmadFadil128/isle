// SPDX-License-Identifier: GPL-3.0-or-later

//! Battery, network and Bluetooth status from the system bus, and events
//! when they change (charger plugged in, Wi-Fi lost, earbuds connected...).

mod bluetooth;
mod camera;
mod network;
mod power;

use std::time::Duration;

use futures_util::{Stream, StreamExt};
use log::{debug, warn};
use serde::Serialize;
use tokio::time::Instant;
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::{Connection, interface};

/// Changes arriving within this window are handled together, so a burst of
/// property updates (or a network briefly reconnecting) yields one event.
const SETTLE: Duration = Duration::from_millis(800);

/// First wait before restarting a watcher that stopped; it doubles with
/// every failure in a row, up to [`RESTART_MAX`].
const RESTART_MIN: Duration = Duration::from_secs(1);
const RESTART_MAX: Duration = Duration::from_secs(60);
/// A watcher that ran at least this long was healthy, so the next restart
/// after it stops is quick again.
const HEALTHY_AFTER: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SystemState {
    pub battery: Option<Battery>,
    pub network: Network,
    pub bluetooth: Vec<BluetoothDevice>,
    /// A camera is open in some app (privacy indicator).
    pub camera_in_use: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Battery {
    pub percent: f64,
    /// Connected to power, whether or not it is currently charging.
    pub plugged: bool,
    pub charging: bool,
    pub time_to_empty_s: i64,
    pub time_to_full_s: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Network {
    pub connected: bool,
    /// "wifi", "ethernet", "other", or empty when disconnected. (Not called
    /// `kind`: events are tagged with a `kind` field of their own.)
    pub connection: String,
    /// Connection name; the network name (SSID) for Wi-Fi.
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BluetoothDevice {
    pub path: String,
    pub name: String,
    /// Freedesktop icon name, e.g. "audio-headphones".
    pub icon: String,
    pub battery: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SystemEvent {
    Power {
        plugged: bool,
        percent: f64,
    },
    BatteryLow {
        percent: f64,
    },
    BatteryFull,
    Network(Network),
    Bluetooth {
        connected: bool,
        device: BluetoothDevice,
    },
}

#[derive(Default)]
pub struct SystemService {
    state: SystemState,
}

#[interface(name = "io.github.zickrian.isle.System1")]
impl SystemService {
    /// JSON `SystemState`.
    #[zbus(property)]
    fn state(&self) -> String {
        serde_json::to_string(&self.state).unwrap_or_default()
    }

    /// JSON `SystemEvent`, tagged by its "kind" field.
    #[zbus(signal)]
    async fn event(emitter: &SignalEmitter<'_>, event: &str) -> zbus::Result<()>;
}

/// Starts every system watcher. Missing services (no battery, no BlueZ) are
/// logged and retried now and then.
pub fn spawn_watchers(system: Connection, iface: InterfaceRef<SystemService>) {
    let (bus, state) = (system.clone(), iface.clone());
    supervise("battery", move || power::watch(bus.clone(), state.clone()));
    let (bus, state) = (system.clone(), iface.clone());
    supervise("network", move || {
        network::watch(bus.clone(), state.clone())
    });
    let state = iface.clone();
    supervise("bluetooth", move || {
        bluetooth::watch(system.clone(), state.clone())
    });
    supervise("camera", move || camera::watch(iface.clone()));
}

/// Runs the watcher from `start`, restarting it whenever it stops (UPower, NetworkManager and
/// BlueZ can restart under us), backing off from [`RESTART_MIN`] to [`RESTART_MAX`].
fn supervise<F, W>(name: &'static str, start: F)
where
    F: Fn() -> W + Send + 'static,
    W: Future<Output = anyhow::Result<()>> + Send + 'static,
{
    tokio::spawn(async move {
        let mut delay = RESTART_MIN;
        loop {
            let started = Instant::now();
            let result = start().await;
            if started.elapsed() >= HEALTHY_AFTER {
                delay = RESTART_MIN;
            }
            let reason = match result {
                Ok(()) => "its events ended".to_owned(),
                Err(err) => err.to_string(),
            };
            // Only the first failure in a row is worth a warning; repeats
            // (e.g. no BlueZ on this machine) would just fill the journal.
            if delay == RESTART_MIN {
                warn!("{name} monitoring stopped ({reason}); restarting in {delay:?}");
            } else {
                debug!("{name} monitoring stopped ({reason}); restarting in {delay:?}");
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(RESTART_MAX);
        }
    });
}

/// Applies `update` to the state, publishes it if it changed, and emits `event`.
async fn publish(
    iface: &InterfaceRef<SystemService>,
    update: impl FnOnce(&mut SystemState),
    event: Option<SystemEvent>,
) {
    let mut service = iface.get_mut().await;
    let before = service.state.clone();
    update(&mut service.state);
    let emitter = iface.signal_emitter();
    let result = async {
        if service.state != before {
            service.state_changed(emitter).await?;
        }
        if let Some(event) = event {
            let json = serde_json::to_string(&event).unwrap_or_default();
            SystemService::event(emitter, &json).await?;
        }
        zbus::Result::Ok(())
    };
    if let Err(err) = result.await {
        warn!("could not publish system state: {err}");
    }
}

/// Waits for the next item, then for the stream to stay quiet for [`SETTLE`].
/// Returns `false` once the stream has ended.
async fn settled<S: Stream + Unpin>(stream: &mut S) -> bool {
    if stream.next().await.is_none() {
        return false;
    }
    while let Ok(item) = tokio::time::timeout(SETTLE, stream.next()).await {
        if item.is_none() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_tagged_without_clashing_fields() {
        let event = SystemEvent::Network(Network {
            connected: true,
            connection: "wifi".into(),
            name: "Home".into(),
        });
        let json: serde_json::Value = serde_json::to_value(&event).unwrap();
        assert_eq!(json["kind"], "network");
        assert_eq!(json["connection"], "wifi");
    }
}
