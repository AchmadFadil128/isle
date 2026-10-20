// SPDX-License-Identifier: GPL-3.0-or-later

//! The file shelf: files parked on the island to be dragged somewhere later.
//!
//! The shelf only remembers where files are; it never copies or moves them.

use serde::{Deserialize, Serialize};

/// Older items are dropped once the shelf holds more than this.
pub const CAPACITY: usize = 24;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShelfItem {
    /// `file://` URI of the item.
    pub uri: String,
    /// Display name, usually the file name.
    pub name: String,
    pub added_at_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Shelf {
    items: Vec<ShelfItem>,
}

impl Shelf {
    pub fn items(&self) -> &[ShelfItem] {
        &self.items
    }

    /// Adds an item at the front, moving it there if already present.
    pub fn add(&mut self, item: ShelfItem) {
        self.items.retain(|existing| existing.uri != item.uri);
        self.items.insert(0, item);
        self.items.truncate(CAPACITY);
    }

    pub fn remove(&mut self, uri: &str) -> bool {
        let before = self.items.len();
        self.items.retain(|item| item.uri != uri);
        self.items.len() != before
    }

    pub fn clear(&mut self) {
        self.items.clear();
    }

    /// Keeps only the items for which `exists` returns true.
    pub fn retain_existing(&mut self, exists: impl Fn(&ShelfItem) -> bool) -> bool {
        let before = self.items.len();
        self.items.retain(exists);
        self.items.len() != before
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(uri: &str) -> ShelfItem {
        ShelfItem {
            uri: uri.into(),
            name: uri.into(),
            added_at_ms: 0,
        }
    }

    #[test]
    fn re_adding_moves_to_front() {
        let mut shelf = Shelf::default();
        shelf.add(item("a"));
        shelf.add(item("b"));
        shelf.add(item("a"));
        let uris: Vec<_> = shelf.items().iter().map(|i| i.uri.as_str()).collect();
        assert_eq!(uris, ["a", "b"]);
    }

    #[test]
    fn capacity_drops_oldest() {
        let mut shelf = Shelf::default();
        for n in 0..=CAPACITY {
            shelf.add(item(&n.to_string()));
        }
        assert_eq!(shelf.items().len(), CAPACITY);
        assert_eq!(shelf.items().last().unwrap().uri, "1");
    }
}
