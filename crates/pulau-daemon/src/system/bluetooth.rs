use std::collections::HashMap;
use std::time::Duration;

use futures_util::StreamExt;
use zbus::fdo::{ObjectManagerProxy, PropertiesProxy};
use zbus::message::Type as MessageType;
use zbus::names::InterfaceName;
use zbus::object_server::InterfaceRef;
use zbus::zvariant::{ObjectPath, OwnedValue};
use zbus::{Connection, MatchRule, MessageStream};

use super::{BluetoothDevice, SystemEvent, SystemService, publish};

const BLUEZ: &str = "org.bluez";
const DEVICE: &str = "org.bluez.Device1";
const BATTERY: &str = "org.bluez.Battery1";
/// Headsets usually report their battery a moment after connecting.
const BATTERY_GRACE: Duration = Duration::from_millis(2500);

pub async fn watch(system: Connection, iface: InterfaceRef<SystemService>) -> anyhow::Result<()> {
    let manager = ObjectManagerProxy::builder(&system)
        .destination(BLUEZ)?
        .path("/")?
        .build()
        .await?;
    let rule = MatchRule::builder()
        .msg_type(MessageType::Signal)
        .sender(BLUEZ)?
        .interface("org.freedesktop.DBus.Properties")?
        .member("PropertiesChanged")?
        .build();
    let mut changes = MessageStream::for_match_rule(rule, &system, None).await?;
    let mut added = manager.receive_interfaces_added().await?;

    // Devices that were already connected when Pulau started.
    let mut connected = Vec::new();
    for (path, interfaces) in manager.get_managed_objects().await? {
        let is_connected = interfaces
            .get(DEVICE)
            .and_then(|props| props.get("Connected"))
            .and_then(|v| bool::try_from(v).ok())
            .unwrap_or(false);
        if is_connected {
            connected.push(read_device(&system, &path).await?);
        }
    }
    publish(&iface, |state| state.bluetooth = connected, None).await;

    loop {
        tokio::select! {
            Some(message) = changes.next() => {
                let Ok(message) = message else { continue };
                let header = message.header();
                let Some(path) = header.path() else { continue };
                let Ok((interface, changed, _)) =
                    message.body().deserialize::<(String, HashMap<String, OwnedValue>, Vec<String>)>()
                else {
                    continue;
                };
                if interface == DEVICE {
                    if let Some(now) = changed.get("Connected").and_then(|v| bool::try_from(v).ok()) {
                        connection_changed(&system, &iface, path.to_owned(), now).await;
                    }
                } else if interface == BATTERY {
                    if let Some(percent) = changed.get("Percentage").and_then(|v| u8::try_from(v).ok()) {
                        set_battery(&iface, path.as_str(), percent).await;
                    }
                }
            }
            Some(signal) = added.next() => {
                let Ok(args) = signal.args() else { continue };
                let percent = args
                    .interfaces_and_properties()
                    .get(BATTERY)
                    .and_then(|props| props.get("Percentage"))
                    .and_then(|v| u8::try_from(v).ok());
                if let Some(percent) = percent {
                    set_battery(&iface, args.object_path().as_str(), percent).await;
                }
            }
            else => return Ok(()),
        }
    }
}

async fn connection_changed(
    system: &Connection,
    iface: &InterfaceRef<SystemService>,
    path: ObjectPath<'static>,
    now_connected: bool,
) {
    if now_connected {
        // Wait for the battery level in a separate task, so other devices'
        // updates are not held up.
        let (system, iface) = (system.clone(), iface.clone());
        tokio::spawn(async move {
            tokio::time::sleep(BATTERY_GRACE).await;
            let Ok(device) = read_device(&system, &path).await else { return };
            let event = SystemEvent::Bluetooth {
                connected: true,
                device: device.clone(),
            };
            publish(
                &iface,
                |state| {
                    state.bluetooth.retain(|d| d.path != device.path);
                    state.bluetooth.push(device);
                },
                Some(event),
            )
            .await;
        });
    } else {
        let known = iface.get().await.state.bluetooth.iter().find(|d| d.path == path.as_str()).cloned();
        let Some(device) = known else { return };
        let event = SystemEvent::Bluetooth {
            connected: false,
            device,
        };
        publish(iface, |state| state.bluetooth.retain(|d| d.path != path.as_str()), Some(event)).await;
    }
}

async fn set_battery(iface: &InterfaceRef<SystemService>, path: &str, percent: u8) {
    publish(
        iface,
        |state| {
            if let Some(device) = state.bluetooth.iter_mut().find(|d| d.path == path) {
                device.battery = Some(percent);
            }
        },
        None,
    )
    .await;
}

async fn read_device(system: &Connection, path: &ObjectPath<'_>) -> zbus::Result<BluetoothDevice> {
    let properties = PropertiesProxy::builder(system)
        .destination(BLUEZ)?
        .path(path.to_owned())?
        .build()
        .await?;
    let device = properties
        .get_all(InterfaceName::from_static_str_unchecked(DEVICE))
        .await?;
    let text = |key: &str| device.get(key).and_then(|v| String::try_from(v.try_clone().ok()?).ok());
    let battery = properties
        .get(InterfaceName::from_static_str_unchecked(BATTERY), "Percentage")
        .await
        .ok()
        .and_then(|v| u8::try_from(v).ok());

    Ok(BluetoothDevice {
        path: path.to_string(),
        name: text("Alias").or_else(|| text("Name")).unwrap_or_else(|| "Bluetooth device".into()),
        icon: text("Icon").unwrap_or_else(|| "bluetooth".into()),
        battery,
    })
}
