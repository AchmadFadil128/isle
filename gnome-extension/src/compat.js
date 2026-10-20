// SPDX-License-Identifier: GPL-3.0-or-later

// The few places GNOME Shell 46 to 51 differ for Isle, so the rest of the
// code reads the same on all of them.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';

const SHELL_MAJOR = parseInt(PACKAGE_VERSION, 10);

/** Vertical box params: GNOME 48 added `orientation`, GNOME 51 dropped `vertical`. */
export const VERTICAL = SHELL_MAJOR >= 48
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

/** Clutter's backend; GNOME 51 only reaches it through the stage's context. */
export function clutterBackend() {
    return Clutter.get_default_backend
        ? Clutter.get_default_backend()
        : global.stage.context.get_backend();
}

/** Whether the shell runs on Wayland; GNOME 50 dropped X11 and the check. */
export function isWayland() {
    return Meta.is_wayland_compositor?.() ?? true;
}
