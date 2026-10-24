// SPDX-License-Identifier: GPL-3.0-or-later

// The few places GNOME Shell 46 to 51 differ for Isle, so the rest of the
// code reads the same on all of them.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';

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

/** Whether `grab` (from `Main.pushModal`) holds the keyboard; GNOME 50 dropped `get_seat_state`. */
export function grabsKeyboard(grab) {
    if (grab.get_seat_state)
        return Boolean(grab.get_seat_state() & Clutter.GrabState.KEYBOARD);
    return !grab.is_revoked();
}

/** Maximizes `window`; GNOME 49 dropped the flags (its `Meta.MaximizeFlags` is still there, so test the version). */
export function maximize(window) {
    return SHELL_MAJOR >= 49 ? window.maximize() : window.maximize(Meta.MaximizeFlags.BOTH);
}

/** Unmaximizes `window`; see `maximize`. */
export function unmaximize(window) {
    return SHELL_MAJOR >= 49 ? window.unmaximize() : window.unmaximize(Meta.MaximizeFlags.BOTH);
}

/** The actor `event` is for: the stage says where it can, as `Clutter.Event.get_source` is going from Clutter. */
export function eventActor(event) {
    return global.stage.get_event_actor?.(event) ?? event.get_source?.() ?? null;
}

/** Whether the shell runs on Wayland; GNOME 50 dropped X11 and the check. */
export function isWayland() {
    return Meta.is_wayland_compositor?.() ?? true;
}

/** Stage pixels per CSS pixel: 2 on a 200% display GNOME 46 to 49 lay out in physical pixels, else 1.
 * St scales what CSS sizes, never what code sets: that takes `px`. */
export function uiScale() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

/** `n` CSS pixels in stage pixels, for a size, place or distance set from code (never an icon's `icon_size`). */
export function px(n) {
    return n * uiScale();
}

/** Calls `apply(scale)` now (unless `now` is false) and whenever `uiScale` changes, while `actor` lives:
 * before the next frame, once St restyled for the new scale, so what is measured then is right. */
export function onUiScale(actor, apply, {now = true} = {}) {
    const context = St.ThemeContext.get_for_stage(global.stage);
    if (now)
        apply(context.scale_factor);
    const laters = global.compositor.get_laters();
    let later = 0;
    const id = context.connect('notify::scale-factor', () => {
        later ||= laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            later = 0;
            apply(context.scale_factor);
            return false;
        });
    });
    actor.connect('destroy', () => {
        context.disconnect(id);
        if (later)
            laters.remove(later);
    });
}
