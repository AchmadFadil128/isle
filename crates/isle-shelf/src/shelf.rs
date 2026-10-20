// SPDX-License-Identifier: GPL-3.0-or-later

//! The shelf window: tiles for the files on the shelf, a drop zone, and the
//! link to isled, which owns the list.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use gtk::{gdk, gio, glib, prelude::*};
use gtk4 as gtk;
use log::warn;
use serde::Deserialize;

use crate::{tile, x11};

const DAEMON: &str = "io.github.isle.Daemon";
const DAEMON_PATH: &str = "/io/github/isle/Daemon";
const SHELF_INTERFACE: &str = "io.github.isle.Shelf1";
/// isled keeps this many files; a full shelf turns drops away.
const CAPACITY: usize = 5;

/// One file on the shelf, as isled describes it.
#[derive(Debug, Clone, Deserialize)]
pub struct Item {
    pub uri: String,
    pub name: String,
}

#[derive(Clone)]
pub struct ShelfWindow(Rc<Inner>);

struct Inner {
    window: gtk::Window,
    stack: gtk::Stack,
    tiles: gtk::Box,
    daemon: RefCell<Option<gio::DBusProxy>>,
    /// Where the window belongs (x, y, width, height), kept for re-placing.
    area: Cell<Option<(i32, i32, i32, i32)>>,
    /// The shelf holds `CAPACITY` files already.
    full: Cell<bool>,
}

impl ShelfWindow {
    pub fn new(app: &gtk::Application) -> Self {
        let window = gtk::Window::builder()
            .application(app)
            .title("Isle shelf")
            .decorated(false)
            .resizable(false)
            .css_classes(["isle-shelf"])
            .build();
        window.connect_realize(|window| {
            if let Err(err) = x11::make_override_redirect(window) {
                warn!("could not make the shelf window float above the shell: {err}");
            }
        });

        let tiles = gtk::Box::builder()
            .orientation(gtk::Orientation::Horizontal)
            .spacing(6)
            .valign(gtk::Align::Center)
            .build();
        let scroller = gtk::ScrolledWindow::builder()
            .hscrollbar_policy(gtk::PolicyType::Automatic)
            .vscrollbar_policy(gtk::PolicyType::Never)
            .hexpand(true)
            .child(&tiles)
            .build();
        let filled = gtk::Box::new(gtk::Orientation::Horizontal, 0);
        filled.append(&scroller);

        let stack = gtk::Stack::builder()
            .transition_type(gtk::StackTransitionType::Crossfade)
            .css_classes(["drop-area"])
            .build();
        stack.add_named(&filled, Some("files"));
        stack.add_named(&empty_state(), Some("empty"));
        window.set_child(Some(&stack));

        let shelf = Self(Rc::new(Inner {
            window,
            stack,
            tiles,
            daemon: RefCell::default(),
            area: Cell::default(),
            full: Cell::default(),
        }));
        shelf.accept_drops();
        let weak = Rc::downgrade(&shelf.0);
        shelf.0.window.connect_map(move |_| {
            if let Some(inner) = weak.upgrade() {
                // Just after GDK's own placement on mapping, so this one wins.
                let shelf = ShelfWindow(inner);
                glib::idle_add_local_once(move || shelf.place());
            }
        });
        shelf.connect_daemon();

        shelf.render(&[]);
        shelf
    }

    /// Shows the window over the given area of the screen (logical pixels).
    pub fn show_at(&self, x: i32, y: i32, width: i32, height: i32) {
        self.0.area.set(Some((x, y, width, height)));
        let window = &self.0.window;
        window.set_default_size(width, height);
        window.set_size_request(width, height);
        window.present();
        // Files may have been deleted since the shelf was last shown.
        self.call("Refresh", None);
        // Already on screen (moved, not reshown): place it now. Otherwise the
        // map handler does, since mapping puts the window back where GDK
        // last had it.
        if window.is_mapped() {
            self.place();
        }
    }

    fn place(&self) {
        let Some((x, y, width, height)) = self.0.area.get() else {
            return;
        };
        if let Err(err) = x11::place(&self.0.window, x, y, width, height) {
            warn!("could not position the shelf window: {err}");
        }
    }

    pub fn hide(&self) {
        self.0.window.set_visible(false);
    }

    /// Files dropped anywhere on the window go onto the shelf.
    fn accept_drops(&self) {
        let target = gtk::DropTarget::new(gdk::FileList::static_type(), gdk::DragAction::COPY);
        // Lights up to say "drop here", or dims and refuses when full.
        let weak = Rc::downgrade(&self.0);
        target.connect_enter(move |_, _, _| {
            let Some(inner) = weak.upgrade() else {
                return gdk::DragAction::empty();
            };
            if inner.full.get() {
                inner.stack.add_css_class("full");
                return gdk::DragAction::empty();
            }
            inner.stack.add_css_class("dropping");
            gdk::DragAction::COPY
        });
        let stack = self.0.stack.clone();
        target.connect_leave(move |_| {
            stack.remove_css_class("dropping");
            stack.remove_css_class("full");
        });

        let weak = Rc::downgrade(&self.0);
        target.connect_drop(move |_, value, _, _| {
            let Some(inner) = weak.upgrade() else {
                return false;
            };
            inner.stack.remove_css_class("dropping");
            inner.stack.remove_css_class("full");
            if inner.full.get() {
                return false;
            }
            let Ok(files) = value.get::<gdk::FileList>() else {
                return false;
            };
            let uris: Vec<String> = files
                .files()
                .iter()
                .filter(|file| file.is_native())
                .map(|file| file.uri().to_string())
                .collect();
            if uris.is_empty() {
                return false;
            }
            ShelfWindow(inner).call("Add", Some(&(uris,).to_variant()));
            true
        });
        self.0.window.add_controller(target);
    }

    fn connect_daemon(&self) {
        let weak = Rc::downgrade(&self.0);
        gio::DBusProxy::for_bus(
            gio::BusType::Session,
            gio::DBusProxyFlags::DO_NOT_AUTO_START_AT_CONSTRUCTION,
            None,
            DAEMON,
            DAEMON_PATH,
            SHELF_INTERFACE,
            None::<&gio::Cancellable>,
            move |result| {
                let Some(inner) = weak.upgrade() else { return };
                let proxy = match result {
                    Ok(proxy) => proxy,
                    Err(err) => {
                        warn!("could not reach isled: {err}");
                        return;
                    }
                };
                let shelf = ShelfWindow(inner);
                let weak = Rc::downgrade(&shelf.0);
                // The typed signal helper requires `Send`; this one stays on
                // the main thread like the rest of the UI.
                proxy.connect_local("g-properties-changed", false, move |values| {
                    let proxy = values[0].get::<gio::DBusProxy>().ok()?;
                    if let Some(inner) = weak.upgrade() {
                        ShelfWindow(inner).render(&items(&proxy));
                    }
                    None
                });
                shelf.render(&items(&proxy));
                shelf.0.daemon.replace(Some(proxy));
            },
        );
    }

    fn call(&self, method: &str, args: Option<&glib::Variant>) {
        let Some(proxy) = self.0.daemon.borrow().clone() else {
            return;
        };
        let method = method.to_owned();
        proxy.call(
            &method.clone(),
            args,
            gio::DBusCallFlags::NONE,
            -1,
            None::<&gio::Cancellable>,
            move |result| {
                if let Err(err) = result {
                    warn!("shelf {method} failed: {err}");
                }
            },
        );
    }

    fn render(&self, items: &[Item]) {
        let inner = &self.0;
        inner.full.set(items.len() >= CAPACITY);
        while let Some(child) = inner.tiles.first_child() {
            inner.tiles.remove(&child);
        }
        for item in items {
            let weak = Rc::downgrade(&self.0);
            inner.tiles.append(&tile::new(item, move |uri| {
                if let Some(inner) = weak.upgrade() {
                    ShelfWindow(inner).call("Remove", Some(&(uri,).to_variant()));
                }
            }));
        }
        inner
            .stack
            .set_visible_child_name(if items.is_empty() { "empty" } else { "files" });
    }
}

/// The shelf's items from the proxy's cached `Items` property (JSON).
fn items(proxy: &gio::DBusProxy) -> Vec<Item> {
    proxy
        .cached_property("Items")
        .and_then(|value| value.get::<String>())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn empty_state() -> gtk::Box {
    let box_ = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(4)
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Center)
        .css_classes(["empty"])
        .build();
    box_.append(
        &gtk::Image::builder()
            .icon_name("folder-download-symbolic")
            .pixel_size(28)
            .css_classes(["empty-icon"])
            .build(),
    );
    box_.append(
        &gtk::Label::builder()
            .label("Drop files here")
            .css_classes(["empty-title"])
            .build(),
    );
    box_.append(
        &gtk::Label::builder()
            .label("Then drag them out to any app")
            .css_classes(["empty-hint"])
            .build(),
    );
    box_
}
