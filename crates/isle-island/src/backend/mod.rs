// SPDX-License-Identifier: GPL-3.0-or-later

//! How the island window is placed on screen.
//!
//! Wayland does not let normal windows choose their position, so each display
//! server needs its own mechanism:
//!
//! - `layer-shell`: the wlr-layer-shell protocol (KDE Plasma, Hyprland, Sway,
//!   river, niri, COSMIC...).
//! - `x11`: a dock-type X11 window. Also used on GNOME Wayland via XWayland,
//!   because Mutter does not implement layer-shell.
//!
//! Set `ISLE_BACKEND=layer-shell` or `ISLE_BACKEND=x11` to override the choice.

#[cfg(not(any(feature = "layer-shell", feature = "x11")))]
compile_error!("enable at least one of the `layer-shell` or `x11` features");

#[cfg(feature = "layer-shell")]
mod layer_shell;
#[cfg(feature = "x11")]
mod x11;

use std::env;

use gtk4 as gtk;
use log::info;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    #[cfg(feature = "layer-shell")]
    LayerShell,
    #[cfg(feature = "x11")]
    X11,
}

/// Picks a backend for the current session. Must be called before GTK is
/// initialised, because the X11 backend may need to force `GDK_BACKEND`.
pub fn select() -> Result<Backend, String> {
    let requested = env::var("ISLE_BACKEND").ok();
    let on_wayland = env::var_os("WAYLAND_DISPLAY").is_some()
        && env::var("GDK_BACKEND").map_or(true, |gdk| gdk != "x11");

    let backend = match requested.as_deref() {
        Some("layer-shell") => layer_shell(),
        Some("x11") => x11(on_wayland),
        Some(other) => return Err(format!("unknown ISLE_BACKEND `{other}`")),
        None if on_wayland && !desktop_is_gnome() => layer_shell().or_else(|| x11(true)),
        None => x11(on_wayland),
    };

    let backend = backend.ok_or_else(|| {
        "no usable backend: this build supports neither the session's display \
         server nor a fallback (check the `layer-shell` and `x11` features)"
            .to_string()
    })?;
    info!("using the {backend:?} backend");
    Ok(backend)
}

impl Backend {
    /// Configures `window` for this backend. Call before the window is shown.
    pub fn attach(self, window: &gtk::ApplicationWindow) -> Result<(), String> {
        match self {
            #[cfg(feature = "layer-shell")]
            Self::LayerShell => layer_shell::attach(window),
            #[cfg(feature = "x11")]
            Self::X11 => {
                x11::attach(window);
                Ok(())
            }
        }
    }
}

fn desktop_is_gnome() -> bool {
    // e.g. "GNOME", "ubuntu:GNOME", "pop:GNOME"
    env::var("XDG_CURRENT_DESKTOP")
        .is_ok_and(|desktop| desktop.split(':').any(|name| name == "GNOME"))
}

fn layer_shell() -> Option<Backend> {
    #[cfg(feature = "layer-shell")]
    return Some(Backend::LayerShell);
    #[cfg(not(feature = "layer-shell"))]
    return None;
}

fn x11(on_wayland: bool) -> Option<Backend> {
    #[cfg(feature = "x11")]
    {
        env::var_os("DISPLAY")?;
        if on_wayland {
            info!("this compositor has no layer-shell; running through XWayland");
            // SAFETY: called from `main` before GTK starts or any thread is spawned.
            unsafe { env::set_var("GDK_BACKEND", "x11") };
        }
        Some(Backend::X11)
    }
    #[cfg(not(feature = "x11"))]
    {
        let _ = on_wayland;
        None
    }
}
