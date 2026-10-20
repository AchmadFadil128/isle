// SPDX-License-Identifier: GPL-3.0-or-later

//! A file on the shelf: a preview and name that can be dragged out,
//! double-clicked to open, or removed.

use gtk::{gdk, gio, glib, pango, prelude::*};
use gtk4 as gtk;
use log::warn;

use crate::shelf::Item;

const PREVIEW_SIZE: i32 = 44;

pub fn new(item: &Item, on_remove: impl Fn(String) + 'static) -> gtk::Widget {
    let file = gio::File::for_uri(&item.uri);

    let preview = gtk::Box::builder()
        .width_request(PREVIEW_SIZE)
        .height_request(PREVIEW_SIZE)
        .halign(gtk::Align::Center)
        .css_classes(["preview"])
        .build();
    let icon = gtk::Image::builder()
        .icon_name("text-x-generic")
        .pixel_size(PREVIEW_SIZE)
        .build();
    preview.append(&icon);
    load_preview(&file, &preview, &icon);

    let name = gtk::Label::builder()
        .label(&item.name)
        .ellipsize(pango::EllipsizeMode::Middle)
        .max_width_chars(10)
        .width_chars(10)
        .css_classes(["name"])
        .build();

    let content = gtk::Box::new(gtk::Orientation::Vertical, 6);
    content.append(&preview);
    content.append(&name);

    let remove = gtk::Button::builder()
        .icon_name("window-close-symbolic")
        .tooltip_text("Remove from the shelf")
        .halign(gtk::Align::End)
        .valign(gtk::Align::Start)
        .css_classes(["remove"])
        .build();
    let uri = item.uri.clone();
    remove.connect_clicked(move |_| on_remove(uri.clone()));

    let tile = gtk::Overlay::builder()
        .child(&content)
        .css_classes(["tile"])
        .tooltip_text(&item.name)
        .build();
    tile.add_overlay(&remove);

    // Dragging the tile hands the file to whatever it is dropped on.
    let source = gtk::DragSource::new();
    source.set_actions(gdk::DragAction::COPY);
    let dragged = file.clone();
    source.connect_prepare(move |_, _, _| {
        let files = gdk::FileList::from_array(std::slice::from_ref(&dragged));
        Some(gdk::ContentProvider::for_value(&files.to_value()))
    });
    let drag_icon = preview.clone();
    source.connect_drag_begin(move |source, _| {
        let paintable = gtk::WidgetPaintable::new(Some(&drag_icon));
        source.set_icon(Some(&paintable), PREVIEW_SIZE / 2, PREVIEW_SIZE / 2);
    });
    tile.add_controller(source);

    let click = gtk::GestureClick::new();
    click.connect_released(move |gesture, presses, _, _| {
        if presses == 2 {
            open(
                &file,
                gesture
                    .widget()
                    .and_then(|w| w.root())
                    .and_downcast::<gtk::Window>(),
            );
        }
    });
    tile.add_controller(click);

    tile.upcast()
}

/// Shows the file's thumbnail if one exists, otherwise its type icon.
fn load_preview(file: &gio::File, preview: &gtk::Box, icon: &gtk::Image) {
    let (preview, icon) = (preview.clone(), icon.clone());
    file.query_info_async(
        "standard::icon,thumbnail::path",
        gio::FileQueryInfoFlags::NONE,
        glib::Priority::LOW,
        None::<&gio::Cancellable>,
        move |result| {
            let Ok(info) = result else { return };
            if let Some(path) = info.attribute_byte_string("thumbnail::path") {
                let picture = gtk::Picture::builder()
                    .content_fit(gtk::ContentFit::Cover)
                    .width_request(PREVIEW_SIZE)
                    .height_request(PREVIEW_SIZE)
                    .css_classes(["thumbnail"])
                    .build();
                picture.set_filename(Some(path.as_str()));
                preview.remove(&icon);
                preview.append(&picture);
            } else if let Some(gicon) = info.icon() {
                icon.set_from_gicon(&gicon);
            }
        },
    );
}

fn open(file: &gio::File, parent: Option<gtk::Window>) {
    let launcher = gtk::FileLauncher::new(Some(file));
    launcher.launch(parent.as_ref(), None::<&gio::Cancellable>, |result| {
        if let Err(err) = result {
            warn!("could not open the file: {err}");
        }
    });
}
