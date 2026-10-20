// SPDX-License-Identifier: GPL-3.0-or-later

use std::sync::Arc;

use chrono::Local;
use isle_core::todo::{TodoList, parse_quick_add};
use log::warn;
use tokio::sync::Notify;
use zbus::object_server::{InterfaceRef, SignalEmitter};
use zbus::{fdo, interface};

use crate::clock::{next_midnight, now_ms, start_of_today, wait_until};
use crate::store::Store;

pub struct TodoService {
    list: TodoList,
    store: Store<TodoList>,
    wake: Arc<Notify>,
}

impl TodoService {
    pub fn load() -> Self {
        let store = Store::new("todo");
        let mut list: TodoList = store.load();
        if list.drop_done_before(start_of_today()) {
            store.save(&list);
        }
        Self {
            list,
            store,
            wake: Arc::default(),
        }
    }

    async fn changed(&self, emitter: &SignalEmitter<'_>) -> zbus::Result<()> {
        self.store.save(&self.list);
        self.wake.notify_one();
        self.items_changed(emitter).await
    }
}

fn not_found(id: u64) -> fdo::Error {
    fdo::Error::InvalidArgs(format!("no task with id {id}"))
}

#[interface(name = "io.github.isle.Todo1")]
impl TodoService {
    /// Adds a task from quick-add text such as "Call mum @18:30" or
    /// "Stretch in 20m", and returns its id.
    async fn add(
        &mut self,
        text: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<u64> {
        let (title, due) = parse_quick_add(text, &Local::now());
        if title.is_empty() {
            return Err(fdo::Error::InvalidArgs("a task needs a title".into()));
        }
        let id = self.list.add(&title, due);
        self.changed(&emitter).await?;
        Ok(id)
    }

    async fn set_done(
        &mut self,
        id: u64,
        done: bool,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        if !self.list.set_done(id, done, now_ms()) {
            return Err(not_found(id));
        }
        Ok(self.changed(&emitter).await?)
    }

    async fn rename(
        &mut self,
        id: u64,
        title: &str,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        if !self.list.rename(id, title) {
            return Err(fdo::Error::InvalidArgs(format!(
                "cannot rename task {id} to `{title}`"
            )));
        }
        Ok(self.changed(&emitter).await?)
    }

    async fn remove(
        &mut self,
        id: u64,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        if !self.list.remove(id) {
            return Err(not_found(id));
        }
        Ok(self.changed(&emitter).await?)
    }

    async fn clear_done(
        &mut self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        self.list.clear_done();
        Ok(self.changed(&emitter).await?)
    }

    /// JSON array of `TodoItem`.
    #[zbus(property)]
    fn items(&self) -> String {
        serde_json::to_string(self.list.items()).unwrap_or_default()
    }

    /// A task's due time has arrived.
    #[zbus(signal)]
    async fn due(emitter: &SignalEmitter<'_>, id: u64, title: &str) -> zbus::Result<()>;
}

/// Announces tasks as they come due, and clears yesterday's finished
/// tasks at midnight.
pub async fn run(iface: InterfaceRef<TodoService>) {
    let wake = iface.get().await.wake.clone();
    loop {
        let due = iface.get().await.list.deadline();
        let deadline = [due, next_midnight()].into_iter().flatten().min();
        if !wait_until(deadline, &wake).await {
            continue;
        }

        let mut service = iface.get_mut().await;
        let due = service.list.take_due(now_ms());
        let pruned = service.list.drop_done_before(start_of_today());
        if due.is_empty() && !pruned {
            continue;
        }
        let emitter = iface.signal_emitter();
        let result = async {
            for item in &due {
                TodoService::due(emitter, item.id, &item.title).await?;
            }
            service.changed(emitter).await
        };
        if let Err(err) = result.await {
            warn!("could not announce due tasks: {err}");
        }
    }
}
