// SPDX-License-Identifier: GPL-3.0-or-later

//! `isle-shelf`: the file shelf's drag-and-drop window.
//!
//! GNOME Shell's own widgets cannot exchange drag and drop with apps, so the
//! extension asks this helper to draw the shelf in a borderless window laid
//! exactly over the island's shelf page. The extension calls
//! `io.github.isle.ShelfWindow1.Show(x, y, width, height)` and `Hide()`; the
//! shelf's contents live in isled.
//!
//! The window is an X11 override-redirect window (via XWayland on a Wayland
//! session): those are the only client windows GNOME Shell stacks above its
//! top bar and the island.

mod service;
mod shelf;
mod tile;
mod x11;

use std::env;

use gtk::{gdk, gio, glib, prelude::*};
use gtk4 as gtk;

use crate::shelf::ShelfWindow;

const APP_ID: &str = "io.github.isle.ShelfWindow";

fn main() -> glib::ExitCode {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    // SAFETY: called before GTK starts and before any other thread exists.
    unsafe { env::set_var("GDK_BACKEND", "x11") };

    // The bus name is owned by hand (not through GApplication) so the
    // interface is exported before anyone can call it.
    let app = gtk::Application::builder()
        .application_id(APP_ID)
        .flags(gio::ApplicationFlags::NON_UNIQUE)
        .build();

    app.connect_startup(|app| {
        load_css();
        if let Err(err) = start_service(app) {
            log::error!("could not offer the shelf window on D-Bus: {err}");
            app.quit();
        }
        // Stay running while hidden, waiting for the extension to call Show.
        std::mem::forget(app.hold());
    });
    app.connect_activate(|_| {});
    app.run()
}

fn start_service(app: &gtk::Application) -> Result<(), glib::Error> {
    let connection = gio::bus_get_sync(gio::BusType::Session, None::<&gio::Cancellable>)?;
    service::register(&connection, ShelfWindow::new(app))?;
    let app = app.clone();
    // The name stays owned for as long as the process runs.
    gio::bus_own_name_on_connection(
        &connection,
        APP_ID,
        gio::BusNameOwnerFlags::DO_NOT_QUEUE,
        |_, _| {},
        move |_, name| {
            log::info!("{name} is taken; another isle-shelf is running");
            app.quit();
        },
    );
    Ok(())
}

fn load_css() {
    let provider = gtk::CssProvider::new();
    provider.load_from_string(include_str!("style.css"));
    gtk::style_context_add_provider_for_display(
        &gdk::Display::default().expect("GTK has no default display"),
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );
}
