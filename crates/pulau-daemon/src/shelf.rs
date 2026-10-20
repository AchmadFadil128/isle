use std::path::Path;

use pulau_core::shelf::{Shelf, ShelfItem};
use url::Url;
use zbus::object_server::SignalEmitter;
use zbus::{fdo, interface};

use crate::clock::now_ms;
use crate::store::Store;

pub struct ShelfService {
    shelf: Shelf,
    store: Store<Shelf>,
}

impl ShelfService {
    pub fn load() -> Self {
        let store = Store::new("shelf");
        let mut shelf: Shelf = store.load();
        // Files may have been moved or deleted while Pulau was not running.
        if shelf.retain_existing(|item| file_exists(&item.uri)) {
            store.save(&shelf);
        }
        Self { shelf, store }
    }

    async fn changed(&self, emitter: &SignalEmitter<'_>) -> zbus::Result<()> {
        self.store.save(&self.shelf);
        self.items_changed(emitter).await
    }
}

#[interface(name = "io.github.pulau.Shelf1")]
impl ShelfService {
    /// Adds local files by `file://` URI. Other URIs are rejected.
    async fn add(&mut self, uris: Vec<String>, #[zbus(signal_emitter)] emitter: SignalEmitter<'_>) -> fdo::Result<()> {
        for uri in uris {
            let path = Url::parse(&uri)
                .ok()
                .and_then(|url| url.to_file_path().ok())
                .ok_or_else(|| fdo::Error::InvalidArgs(format!("not a local file: {uri}")))?;
            let name = path
                .file_name()
                .map_or_else(|| uri.clone(), |name| name.to_string_lossy().into_owned());
            self.shelf.add(ShelfItem {
                uri,
                name,
                added_at_ms: now_ms(),
            });
        }
        Ok(self.changed(&emitter).await?)
    }

    async fn remove(&mut self, uri: &str, #[zbus(signal_emitter)] emitter: SignalEmitter<'_>) -> fdo::Result<()> {
        if self.shelf.remove(uri) {
            self.changed(&emitter).await?;
        }
        Ok(())
    }

    async fn clear(&mut self, #[zbus(signal_emitter)] emitter: SignalEmitter<'_>) -> fdo::Result<()> {
        self.shelf.clear();
        Ok(self.changed(&emitter).await?)
    }

    /// Drops items whose files no longer exist.
    async fn refresh(&mut self, #[zbus(signal_emitter)] emitter: SignalEmitter<'_>) -> fdo::Result<()> {
        if self.shelf.retain_existing(|item| file_exists(&item.uri)) {
            self.changed(&emitter).await?;
        }
        Ok(())
    }

    /// JSON array of `ShelfItem`, newest first.
    #[zbus(property)]
    fn items(&self) -> String {
        serde_json::to_string(self.shelf.items()).unwrap_or_default()
    }
}

fn file_exists(uri: &str) -> bool {
    Url::parse(uri)
        .ok()
        .and_then(|url| url.to_file_path().ok())
        .is_some_and(|path| Path::new(&path).exists())
}
