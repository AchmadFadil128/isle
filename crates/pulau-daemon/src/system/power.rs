use std::collections::HashMap;

use zbus::Connection;
use zbus::fdo::PropertiesProxy;
use zbus::names::InterfaceName;
use zbus::object_server::InterfaceRef;
use zbus::proxy::CacheProperties;
use zbus::zvariant::OwnedValue;

use super::{Battery, SystemEvent, SystemService, publish, settled};

const DESTINATION: &str = "org.freedesktop.UPower";
/// UPower's combined view of all batteries.
const PATH: &str = "/org/freedesktop/UPower/devices/DisplayDevice";
const INTERFACE: &str = "org.freedesktop.UPower.Device";

/// Percentages at which a low-battery warning is shown, once each.
const LOW_LEVELS: [f64; 3] = [20.0, 10.0, 5.0];

// UPower device types and states.
const TYPE_BATTERY: u32 = 2;
const STATE_CHARGING: u32 = 1;
const STATE_FULLY_CHARGED: u32 = 4;
const STATE_PENDING_CHARGE: u32 = 5;

pub async fn watch(system: Connection, iface: InterfaceRef<SystemService>) -> anyhow::Result<()> {
    let properties = PropertiesProxy::builder(&system)
        .destination(DESTINATION)?
        .path(PATH)?
        .cache_properties(CacheProperties::No)
        .build()
        .await?;
    let mut changes = properties.receive_properties_changed().await?;
    let mut previous: Option<(Battery, bool)> = None;

    loop {
        let all = properties
            .get_all(InterfaceName::from_static_str_unchecked(INTERFACE))
            .await?;
        let current = read(&all);

        let event = match (&previous, &current) {
            (Some((before, _)), Some((now, _))) if before.plugged != now.plugged => Some(SystemEvent::Power {
                plugged: now.plugged,
                percent: now.percent,
            }),
            (Some((_, was_full)), Some((now, true))) if !was_full && now.plugged => Some(SystemEvent::BatteryFull),
            (Some((before, _)), Some((now, _))) if !now.plugged => LOW_LEVELS
                .into_iter()
                .any(|level| before.percent > level && now.percent <= level)
                .then_some(SystemEvent::BatteryLow { percent: now.percent }),
            _ => None,
        };

        let battery = current.as_ref().map(|(battery, _)| battery.clone());
        publish(&iface, |state| state.battery = battery, event).await;
        previous = current;

        if !settled(&mut changes).await {
            return Ok(());
        }
    }
}

/// The battery and whether it is fully charged, or `None` without a battery.
fn read(all: &HashMap<String, OwnedValue>) -> Option<(Battery, bool)> {
    let u32_of = |key: &str| all.get(key).and_then(|v| u32::try_from(v).ok());
    let i64_of = |key: &str| all.get(key).and_then(|v| i64::try_from(v).ok()).unwrap_or(0);

    let present = all.get("IsPresent").and_then(|v| bool::try_from(v).ok()).unwrap_or(false);
    if !present || u32_of("Type") != Some(TYPE_BATTERY) {
        return None;
    }
    let state = u32_of("State").unwrap_or(0);
    let battery = Battery {
        percent: all.get("Percentage").and_then(|v| f64::try_from(v).ok()).unwrap_or(0.0),
        plugged: matches!(state, STATE_CHARGING | STATE_FULLY_CHARGED | STATE_PENDING_CHARGE),
        charging: state == STATE_CHARGING,
        time_to_empty_s: i64_of("TimeToEmpty"),
        time_to_full_s: i64_of("TimeToFull"),
    };
    Some((battery, state == STATE_FULLY_CHARGED))
}
