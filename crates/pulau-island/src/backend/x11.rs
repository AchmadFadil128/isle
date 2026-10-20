use gtk::{gdk, prelude::*};
use gtk4 as gtk;
use log::warn;
use x11rb::connection::Connection;
use x11rb::properties::{WmSizeHints, WmSizeHintsSpecification};
use x11rb::protocol::xproto::{AtomEnum, ConfigureWindowAux, ConnectionExt as _, PropMode, Window};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

type Error = Box<dyn std::error::Error>;

x11rb::atom_manager! {
    Atoms: AtomsCookie {
        _NET_WM_WINDOW_TYPE,
        _NET_WM_WINDOW_TYPE_DOCK,
        _NET_WORKAREA,
    }
}

pub fn attach(window: &gtk::ApplicationWindow) {
    // The X window exists once GTK realizes it, and its type must be set
    // before it is mapped for the window manager to honour it.
    window.connect_realize(|window| {
        if let Err(err) = X11::connect().and_then(|x11| x11.make_dock(window)) {
            warn!("could not turn the island into a dock window: {err}");
        }
    });
    // Window managers may still place the window themselves when mapping it,
    // so move it into position once more afterwards.
    window.connect_map(|window| {
        if let Err(err) = X11::connect().and_then(|x11| x11.move_to_top_centre(window)) {
            warn!("could not position the island: {err}");
        }
    });
}

/// A short-lived connection used to adjust the window GTK created.
struct X11 {
    conn: RustConnection,
    root: Window,
    atoms: Atoms,
}

impl X11 {
    fn connect() -> Result<Self, Error> {
        let (conn, screen) = x11rb::connect(None)?;
        let root = conn.setup().roots[screen].root;
        let atoms = Atoms::new(&conn)?.reply()?;
        Ok(Self { conn, root, atoms })
    }

    /// Dock windows stay above normal windows, appear on every workspace and
    /// are left out of the taskbar and window switcher.
    fn make_dock(&self, window: &gtk::ApplicationWindow) -> Result<(), Error> {
        let xid = xid(window)?;
        self.conn.change_property32(
            PropMode::REPLACE,
            xid,
            self.atoms._NET_WM_WINDOW_TYPE,
            AtomEnum::ATOM,
            &[self.atoms._NET_WM_WINDOW_TYPE_DOCK],
        )?;

        let (x, y) = self.top_centre(window)?;
        let mut hints = WmSizeHints::new();
        hints.position = Some((WmSizeHintsSpecification::ProgramSpecified, x, y));
        hints.set_normal_hints(&self.conn, xid)?;
        self.conn.flush()?;
        Ok(())
    }

    fn move_to_top_centre(&self, window: &gtk::ApplicationWindow) -> Result<(), Error> {
        let (x, y) = self.top_centre(window)?;
        self.conn
            .configure_window(xid(window)?, &ConfigureWindowAux::new().x(x).y(y))?;
        self.conn.flush()?;
        Ok(())
    }

    /// Top-centre of the first monitor in device pixels, kept below any top
    /// panel (such as GNOME's top bar) that the island cannot be drawn over.
    fn top_centre(&self, window: &gtk::ApplicationWindow) -> Result<(i32, i32), Error> {
        let monitor = WidgetExt::display(window)
            .monitors()
            .item(0)
            .and_downcast::<gdk::Monitor>()
            .ok_or("no monitor found")?;
        let geometry = monitor.geometry();
        let scale = monitor.scale_factor();
        let (width, _) = window.default_size();

        let x = (geometry.x() + (geometry.width() - width) / 2) * scale;
        let y = (geometry.y() * scale).max(self.workarea_top().unwrap_or(0));
        Ok((x, y))
    }

    fn workarea_top(&self) -> Option<i32> {
        // _NET_WORKAREA holds x, y, width, height for each workspace.
        let reply = self
            .conn
            .get_property(false, self.root, self.atoms._NET_WORKAREA, AtomEnum::CARDINAL, 0, 4)
            .ok()?
            .reply()
            .ok()?;
        let y = reply.value32()?.nth(1)?;
        i32::try_from(y).ok()
    }
}

fn xid(window: &gtk::ApplicationWindow) -> Result<Window, Error> {
    let surface = window
        .surface()
        .ok_or("the window has no surface yet")?
        .downcast::<gdk4_x11::X11Surface>()
        .map_err(|_| "the window is not an X11 window")?;
    Ok(Window::try_from(surface.xid())?)
}
