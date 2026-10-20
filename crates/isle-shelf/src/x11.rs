// SPDX-License-Identifier: GPL-3.0-or-later

//! Turning GTK's window into an override-redirect X11 window and placing it.

use gtk::prelude::*;
use gtk4 as gtk;
use x11rb::protocol::xproto::{
    ChangeWindowAttributesAux, ConfigureWindowAux, ConnectionExt as _, Window,
};

type Error = Box<dyn std::error::Error>;

/// Makes the realized, unmapped window override-redirect: undecorated, unplaced
/// by the window manager, and stacked by GNOME Shell above its own chrome.
pub fn make_override_redirect(window: &gtk::Window) -> Result<(), Error> {
    let xid = xid(window)?;
    sync_gdk(window);
    let (conn, _) = x11rb::connect(None)?;
    let attributes = ChangeWindowAttributesAux::new().override_redirect(1);
    conn.change_window_attributes(xid, &attributes)?.check()?;
    Ok(())
}

/// Moves and resizes the window. Coordinates are in logical pixels.
pub fn place(window: &gtk::Window, x: i32, y: i32, width: i32, height: i32) -> Result<(), Error> {
    let scale = window.scale_factor();
    let xid = xid(window)?;
    sync_gdk(window);
    let (conn, _) = x11rb::connect(None)?;
    let geometry = ConfigureWindowAux::new()
        .x(x * scale)
        .y(y * scale)
        .width((width * scale) as u32)
        .height((height * scale) as u32);
    conn.configure_window(xid, &geometry)?.check()?;
    Ok(())
}

/// Flushes GDK's queued requests and waits for the X server: ours use another
/// connection and could beat the window's creation, or GDK's placement undoing ours.
fn sync_gdk(window: &gtk::Window) {
    WidgetExt::display(window).sync();
}

fn xid(window: &gtk::Window) -> Result<Window, Error> {
    let surface = window
        .surface()
        .ok_or("the window has no surface")?
        .downcast::<gdk4_x11::X11Surface>()
        .map_err(|_| "the window is not an X11 window")?;
    Ok(Window::try_from(surface.xid())?)
}
