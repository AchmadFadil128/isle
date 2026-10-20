use zbus::proxy::CacheProperties;
use zbus::zvariant::OwnedObjectPath;
use zbus::{Connection, proxy};

use super::{Network, SystemEvent, SystemService, publish, settled};
use zbus::object_server::InterfaceRef;

/// NetworkManager's NM_STATE_CONNECTED_SITE; anything above means connected.
const STATE_CONNECTED_SITE: u32 = 60;

#[proxy(
    interface = "org.freedesktop.NetworkManager",
    default_service = "org.freedesktop.NetworkManager",
    default_path = "/org/freedesktop/NetworkManager",
    gen_blocking = false
)]
trait NetworkManager {
    #[zbus(property)]
    fn state(&self) -> zbus::Result<u32>;
    #[zbus(property)]
    fn primary_connection(&self) -> zbus::Result<OwnedObjectPath>;
    #[zbus(property)]
    fn primary_connection_type(&self) -> zbus::Result<String>;
}

#[proxy(
    interface = "org.freedesktop.NetworkManager.Connection.Active",
    default_service = "org.freedesktop.NetworkManager",
    gen_blocking = false
)]
trait ActiveConnection {
    #[zbus(property)]
    fn id(&self) -> zbus::Result<String>;
}

pub async fn watch(system: Connection, iface: InterfaceRef<SystemService>) -> anyhow::Result<()> {
    let manager = NetworkManagerProxy::builder(&system)
        .cache_properties(CacheProperties::No)
        .build()
        .await?;
    let properties = zbus::fdo::PropertiesProxy::builder(&system)
        .destination("org.freedesktop.NetworkManager")?
        .path("/org/freedesktop/NetworkManager")?
        .build()
        .await?;
    let mut changes = properties.receive_properties_changed().await?;
    let mut previous: Option<Network> = None;

    loop {
        let current = read(&system, &manager).await?;
        let event = previous
            .as_ref()
            .filter(|before| {
                before.connected != current.connected || (current.connected && before.name != current.name)
            })
            .map(|_| SystemEvent::Network(current.clone()));

        let network = current.clone();
        publish(&iface, |state| state.network = network, event).await;
        previous = Some(current);

        if !settled(&mut changes).await {
            return Ok(());
        }
    }
}

async fn read(system: &Connection, manager: &NetworkManagerProxy<'_>) -> zbus::Result<Network> {
    if manager.state().await? < STATE_CONNECTED_SITE {
        return Ok(Network::default());
    }
    let connection = match manager.primary_connection_type().await?.as_str() {
        "802-11-wireless" => "wifi",
        "802-3-ethernet" => "ethernet",
        _ => "other",
    };
    let path = manager.primary_connection().await?;
    let name = match ActiveConnectionProxy::builder(system).path(path)?.build().await {
        Ok(connection) => connection.id().await.unwrap_or_default(),
        Err(_) => String::new(),
    };
    Ok(Network {
        connected: true,
        connection: connection.into(),
        name,
    })
}
