// SPDX-License-Identifier: GPL-3.0-or-later

mod backend;
mod island;

use gtk::{gdk, glib, prelude::*};
use gtk4 as gtk;
use log::error;

use crate::backend::Backend;
use crate::island::Island;

const APP_ID: &str = "io.github.isle.Isle";

fn main() -> glib::ExitCode {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // Must run before GTK initialises, since it may pick the GDK backend.
    let backend = match backend::select() {
        Ok(backend) => backend,
        Err(err) => {
            error!("{err}");
            return glib::ExitCode::FAILURE;
        }
    };

    let app = gtk::Application::builder().application_id(APP_ID).build();
    app.connect_startup(|_| load_css());
    app.connect_activate(move |app| {
        // Launching Isle again just re-activates the running instance.
        if app.active_window().is_none() {
            build_window(app, backend);
        }
    });
    app.run()
}

fn build_window(app: &gtk::Application, backend: Backend) {
    let window = gtk::ApplicationWindow::builder()
        .application(app)
        .title("Isle")
        .decorated(false)
        .resizable(false)
        .default_width(island::CANVAS_WIDTH)
        .default_height(island::CANVAS_HEIGHT)
        .css_classes(["isle"])
        .build();

    if let Err(err) = backend.attach(&window) {
        error!("{err}");
        app.quit();
        return;
    }

    let island = Island::new();
    window.set_child(Some(island.widget()));
    // The island's state lives as long as its window.
    window.connect_destroy(move |_| island.shutdown());
    window.present();
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
