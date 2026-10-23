// SPDX-License-Identifier: GPL-3.0-or-later

//! The see-through shelf window: the files' tiles and the drop zone; isled owns the list.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use gtk::{gdk, gdk_pixbuf, gio, glib, prelude::*};
use gtk4 as gtk;
use log::warn;
use serde::Deserialize;

use crate::{tile, x11};

const DAEMON: &str = "io.github.zickrian.isle.Daemon";
const DAEMON_PATH: &str = "/io/github/zickrian/isle/Daemon";
const SHELF_INTERFACE: &str = "io.github.zickrian.isle.Shelf1";
/// The island's own shelf icon, so the empty shelf looks the same in both, whatever the icon theme.
const SHELF_ICON: &[u8] = include_bytes!("../../../gnome-extension/icons/isle-shelf.svg");
/// isled keeps this many files; a full shelf turns drops away.
const CAPACITY: usize = 6;
/// Hidden this long, the helper quits, its memory freed; the extension's next Show starts it again.
const IDLE_QUIT_SECS: u32 = 20;

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
    empty_title: gtk::Label,
    empty_hint: gtk::Label,
    daemon: RefCell<Option<gio::DBusProxy>>,
    /// Where the window belongs (x, y, width, height), kept for re-placing.
    area: Cell<Option<(i32, i32, i32, i32)>>,
    /// The files on the shelf, newest first.
    items: RefCell<Vec<Item>>,
    /// Each file's tile, kept while the file stays, so its thumbnail loads
    /// once; files without one are new and fade in.
    tile_cache: RefCell<HashMap<String, gtk::Widget>>,
    /// Where a dragged file will land.
    slot: gtk::Widget,
    /// A file is being dragged towards the island (the extension says so).
    near: Cell<bool>,
    /// A file is being dragged over this window.
    over: Cell<bool>,
    /// Quits the helper once hidden for `IDLE_QUIT_SECS`.
    idle_quit: RefCell<Option<glib::SourceId>>,
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

        let empty_title = gtk::Label::builder().css_classes(["empty-title"]).build();
        let empty_hint = gtk::Label::builder().css_classes(["empty-hint"]).build();
        // No crossfade: a new file's tile fades in by itself, and the two
        // states would show through each other meanwhile.
        let stack = gtk::Stack::builder().css_classes(["drop-area"]).build();
        stack.add_named(&filled, Some("files"));
        stack.add_named(&empty_state(&empty_title, &empty_hint), Some("empty"));
        window.set_child(Some(&stack));

        let shelf = Self(Rc::new(Inner {
            window,
            stack,
            tiles,
            empty_title,
            empty_hint,
            daemon: RefCell::default(),
            area: Cell::default(),
            items: RefCell::default(),
            tile_cache: RefCell::default(),
            slot: tile::slot(),
            near: Cell::default(),
            over: Cell::default(),
            idle_quit: RefCell::default(),
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

        shelf.render();
        // Started hidden (by any call, not only Show): it quits unless shown within `IDLE_QUIT_SECS`.
        shelf.hide();
        shelf
    }

    /// Shows the window over the given area of the screen (logical pixels).
    pub fn show_at(&self, x: i32, y: i32, width: i32, height: i32) {
        if let Some(quit) = self.0.idle_quit.take() {
            quit.remove();
        }
        self.0.area.set(Some((x, y, width, height)));
        let window = &self.0.window;
        window.set_default_size(width, height);
        window.set_size_request(width, height);
        window.present();
        // Files may have been deleted since the shelf was last shown.
        self.call("Refresh", None);
        // Already mapped (moved, not reshown): place it now. Otherwise the map
        // handler does, since mapping restores where GDK last had the window.
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
        if self.0.idle_quit.borrow().is_some() {
            return;
        }
        let weak = Rc::downgrade(&self.0);
        let quit = glib::timeout_add_seconds_local_once(IDLE_QUIT_SECS, move || {
            let Some(inner) = weak.upgrade() else { return };
            inner.idle_quit.take();
            if !inner.window.is_visible()
                && let Some(app) = inner.window.application()
            {
                log::info!("the shelf stayed hidden; quitting until it is needed");
                app.quit();
            }
        });
        self.0.idle_quit.replace(Some(quit));
    }

    /// Whether a file is being dragged towards the island: the shelf then
    /// shows where it will land before the pointer even gets here.
    pub fn set_dropping(&self, dropping: bool) {
        if self.0.near.replace(dropping) != dropping {
            self.render();
        }
    }

    fn full(&self) -> bool {
        self.0.items.borrow().len() >= CAPACITY
    }

    /// Files dropped anywhere on the window go onto the shelf.
    fn accept_drops(&self) {
        let target = gtk::DropTarget::new(gdk::FileList::static_type(), gdk::DragAction::COPY);
        // A full shelf refuses the drop; the island's hint says why.
        let weak = Rc::downgrade(&self.0);
        target.connect_enter(move |target, _, _| {
            let Some(inner) = weak.upgrade() else {
                return gdk::DragAction::empty();
            };
            if dragged_from_here(target) {
                return gdk::DragAction::empty();
            }
            let shelf = ShelfWindow(inner);
            shelf.0.over.set(true);
            shelf.render();
            if shelf.full() {
                gdk::DragAction::empty()
            } else {
                gdk::DragAction::COPY
            }
        });
        let weak = Rc::downgrade(&self.0);
        target.connect_leave(move |_| {
            if let Some(inner) = weak.upgrade()
                && inner.over.replace(false)
            {
                ShelfWindow(inner).render();
            }
        });

        let weak = Rc::downgrade(&self.0);
        target.connect_drop(move |target, value, _, _| {
            let Some(inner) = weak.upgrade() else {
                return false;
            };
            if dragged_from_here(target) {
                return false;
            }
            let shelf = ShelfWindow(inner);
            shelf.0.over.set(false);
            shelf.render();
            if shelf.full() {
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
            shelf.call("Add", Some(&(uris,).to_variant()));
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
                        inner.items.replace(items(&proxy));
                        let shelf = ShelfWindow(inner);
                        shelf.render_tiles(true);
                        shelf.render();
                    }
                    None
                });
                shelf.0.items.replace(items(&proxy));
                // What is there at start is not new.
                shelf.render_tiles(false);
                shelf.render();
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

    fn render(&self) {
        let inner = &self.0;
        let count = inner.items.borrow().len();
        let full = count >= CAPACITY;
        let dragging = inner.near.get() || inner.over.get();
        set_class(&inner.stack, "dropping", dragging);
        set_class(&inner.stack, "over", inner.over.get());
        set_class(&inner.stack, "full", dragging && full);

        // Where the file will land: the newest file comes first. The tiles stay as they are.
        let slot = dragging && !full && count > 0;
        if slot != inner.slot.parent().is_some() {
            if slot {
                inner.tiles.prepend(&inner.slot);
            } else {
                inner.tiles.remove(&inner.slot);
            }
        }

        let (title, hint) = if dragging {
            (
                "Drop to add it",
                "Then drag it into any app, or click to copy it",
            )
        } else {
            (
                "Drop files here",
                "Then drag them into any app, or click to copy",
            )
        };
        inner.empty_title.set_label(title);
        inner.empty_hint.set_label(hint);
        inner
            .stack
            .set_visible_child_name(if count == 0 { "empty" } else { "files" });
    }

    /// Lays out a tile per file, newest first, reusing the tiles of files
    /// already shown. With `mark_new`, tiles for new files fade in. Then `render` adds the slot back.
    fn render_tiles(&self, mark_new: bool) {
        let inner = &self.0;
        while let Some(child) = inner.tiles.first_child() {
            inner.tiles.remove(&child);
        }
        let mut old = inner.tile_cache.take();
        let mut cache = HashMap::new();
        for item in inner.items.borrow().iter() {
            let tile = old.remove(&item.uri).unwrap_or_else(|| {
                let weak = Rc::downgrade(&self.0);
                tile::new(item, mark_new, move |uri| {
                    if let Some(inner) = weak.upgrade() {
                        ShelfWindow(inner).call("Remove", Some(&(uri,).to_variant()));
                    }
                })
            });
            inner.tiles.append(&tile);
            cache.insert(item.uri.clone(), tile);
        }
        inner.tile_cache.replace(cache);
    }
}

/// Whether the drag is a tile carried out of this window, not a file coming in.
fn dragged_from_here(target: &gtk::DropTarget) -> bool {
    target.current_drop().and_then(|drop| drop.drag()).is_some()
}

fn set_class(widget: &impl IsA<gtk::Widget>, class: &str, on: bool) {
    if on {
        widget.add_css_class(class);
    } else {
        widget.remove_css_class(class);
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

/// [`SHELF_ICON`] at `size` px, drawn at twice that so it stays sharp on a HiDPI screen.
fn shelf_icon(size: i32) -> gtk::Image {
    let image = gtk::Image::builder()
        .pixel_size(size)
        .css_classes(["empty-icon"])
        .build();
    let stream = gio::MemoryInputStream::from_bytes(&glib::Bytes::from_static(SHELF_ICON));
    match gdk_pixbuf::Pixbuf::from_stream_at_scale(
        &stream,
        size * 2,
        size * 2,
        true,
        gio::Cancellable::NONE,
    ) {
        Ok(pixbuf) => image.set_paintable(Some(&gdk::Texture::for_pixbuf(&pixbuf))),
        Err(err) => {
            warn!("could not draw the shelf icon: {err}");
            image.set_icon_name(Some("folder-download-symbolic"));
        }
    }
    image
}

fn empty_state(title: &gtk::Label, hint: &gtk::Label) -> gtk::Box {
    let box_ = gtk::Box::builder()
        .orientation(gtk::Orientation::Vertical)
        .spacing(4)
        .halign(gtk::Align::Center)
        .valign(gtk::Align::Center)
        .css_classes(["empty"])
        .build();
    box_.append(&shelf_icon(24));
    box_.append(title);
    box_.append(hint);
    box_
}
