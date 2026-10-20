// SPDX-License-Identifier: GPL-3.0-or-later

//! The content drawn on top of the island in each mode.

use std::time::Duration;

use chrono::{Local, Timelike};
use gtk::{glib, prelude::*};
use gtk4 as gtk;
use isle_core::geometry::IslandMode;

pub struct Views {
    pub compact: gtk::Box,
    pub expanded: gtk::Box,
}

impl Views {
    pub fn new() -> Self {
        let compact_time = label("isle-compact-time");
        compact_time.set_hexpand(true);
        let compact = sized_box(IslandMode::Compact, gtk::Orientation::Horizontal);
        compact.append(&compact_time);

        let expanded_date = label("isle-expanded-date");
        expanded_date.set_halign(gtk::Align::Start);
        expanded_date.set_margin_start(28);
        expanded_date.set_margin_top(18);

        let expanded_time = label("isle-expanded-time");
        expanded_time.set_vexpand(true);

        let hint = label("isle-expanded-hint");
        hint.set_label("Nothing is playing");
        hint.set_margin_bottom(18);

        let expanded = sized_box(IslandMode::Expanded, gtk::Orientation::Vertical);
        expanded.append(&expanded_date);
        expanded.append(&expanded_time);
        expanded.append(&hint);

        Clock {
            compact_time: compact_time.downgrade(),
            expanded_time: expanded_time.downgrade(),
            expanded_date: expanded_date.downgrade(),
        }
        .start();

        Self { compact, expanded }
    }
}

/// A box exactly the size of the island in `mode`, pinned to the top centre.
fn sized_box(mode: IslandMode, orientation: gtk::Orientation) -> gtk::Box {
    let shape = mode.shape();
    gtk::Box::builder()
        .orientation(orientation)
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Start)
        .width_request(shape.width as i32)
        .height_request(shape.height as i32)
        .build()
}

fn label(css_class: &str) -> gtk::Label {
    gtk::Label::builder().css_classes([css_class]).build()
}

/// Keeps the time labels current, waking once per minute rather than polling.
/// Stops by itself once the labels are destroyed.
struct Clock {
    compact_time: glib::WeakRef<gtk::Label>,
    expanded_time: glib::WeakRef<gtk::Label>,
    expanded_date: glib::WeakRef<gtk::Label>,
}

impl Clock {
    fn start(self) {
        if !self.refresh() {
            return;
        }
        let now = Local::now();
        let into_minute = u64::from(now.second()) * 1000 + u64::from(now.timestamp_subsec_millis());
        // A few extra milliseconds so we never wake just before the minute turns.
        let wait = Duration::from_millis(60_000 - into_minute.min(60_000) + 5);
        glib::timeout_add_local_once(wait, move || self.start());
    }

    /// Updates the labels; returns `false` once they no longer exist.
    fn refresh(&self) -> bool {
        let (Some(compact_time), Some(expanded_time), Some(expanded_date)) = (
            self.compact_time.upgrade(),
            self.expanded_time.upgrade(),
            self.expanded_date.upgrade(),
        ) else {
            return false;
        };

        let now = Local::now();
        let time = now.format("%H:%M").to_string();
        compact_time.set_label(&time);
        expanded_time.set_label(&time);
        expanded_date.set_label(&now.format("%a %-d %b").to_string());
        true
    }
}
