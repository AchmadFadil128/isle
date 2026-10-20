// SPDX-License-Identifier: GPL-3.0-or-later

use gtk4 as gtk;
use gtk4_layer_shell::{Edge, KeyboardMode, Layer, LayerShell};

pub fn attach(window: &gtk::ApplicationWindow) -> Result<(), String> {
    if !gtk4_layer_shell::is_supported() {
        return Err("this compositor does not support wlr-layer-shell; \
                    try ISLE_BACKEND=x11"
            .into());
    }

    window.init_layer_shell();
    window.set_namespace(Some("isle"));
    // `Top` stays above normal windows but below fullscreen ones, so the
    // island steps aside for games and videos.
    window.set_layer(Layer::Top);
    window.set_anchor(Edge::Top, true);
    // Never steal keyboard focus from the app the user is typing in.
    window.set_keyboard_mode(KeyboardMode::None);
    Ok(())
}
