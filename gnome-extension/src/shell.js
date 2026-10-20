// SPDX-License-Identifier: GPL-3.0-or-later

// Integration with GNOME Shell itself: the top bar, the volume/brightness
// OSD and keyboard state. Everything here is undone in `destroy()`.

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {getInputSourceManager} from 'resource:///org/gnome/shell/ui/status/keyboard.js';

const BLACK_BAR_STYLE = 'background-color: #000000;';
/** Style class making the top bar slimmer; see stylesheet.css. */
const COMPACT_BAR_CLASS = 'isle-compact-bar';

/**
 * Restyles the top bar around the island: paints it black so the island
 * blends in, and hides the clock (the island shows the time) while keeping
 * its calendar menu reachable.
 */
export class TopBar extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._dateMenu = Main.panel.statusArea.dateMenu;
        this._originalPanelStyle = Main.panel.get_style();
        this._dateMenu.opacity = 0;
        this._dateMenu.reactive = false;

        this._settingsChanged = [
            settings.connect('changed::black-top-bar', () => this._applyStyle()),
            settings.connect('changed::compact-top-bar', () => this._applyStyle()),
        ];
        this._applyStyle();

        this._heightChanged = Main.panel.connect('notify::height', () => this.emit('height-changed'));

        this._menuChanged = this._dateMenu.menu.connect('open-state-changed', (_menu, open) =>
            this.emit('calendar-toggled', open));
    }

    get height() {
        return Main.panel.height;
    }

    get calendarActor() {
        return this._dateMenu.menu.actor;
    }

    /** Keeps the top bar's centre clear for the island. */
    reserveWidth(width) {
        this._dateMenu.set_width(Math.ceil(width));
    }

    toggleCalendar() {
        this._dateMenu.menu.toggle();
    }

    _applyStyle() {
        const black = this._settings.get_boolean('black-top-bar');
        Main.panel.set_style(black ? BLACK_BAR_STYLE : this._originalPanelStyle);
        // The bar's height changes with this; `height-changed` re-lays out the island.
        if (this._settings.get_boolean('compact-top-bar'))
            Main.panel.add_style_class_name(COMPACT_BAR_CLASS);
        else
            Main.panel.remove_style_class_name(COMPACT_BAR_CLASS);
    }

    destroy() {
        this._settingsChanged.forEach(id => this._settings.disconnect(id));
        Main.panel.disconnect(this._heightChanged);
        this._dateMenu.menu.disconnect(this._menuChanged);

        Main.panel.set_style(this._originalPanelStyle);
        Main.panel.remove_style_class_name(COMPACT_BAR_CLASS);
        this._dateMenu.set_width(-1);
        this._dateMenu.opacity = 255;
        this._dateMenu.reactive = true;
        this.disconnectAll();
    }
}

/**
 * Routes GNOME's volume and brightness pop-ups to `handler`, which returns
 * whether it showed them; if not, GNOME's own OSD appears as usual.
 */
export class OsdHook {
    constructor(handler) {
        const manager = Main.osdWindowManager;
        this._manager = manager;
        this._original = manager.show;
        const original = this._original;
        manager.show = function (monitorIndex, icon, label, level, maxLevel) {
            if (handler(icon, label, level, maxLevel))
                return;
            original.call(this, monitorIndex, icon, label, level, maxLevel);
        };
    }

    destroy() {
        this._manager.show = this._original;
    }
}

/** Emits `caps-lock` (on) and `input-source` (source) when they change. */
export class KeyboardWatcher extends Signals.EventEmitter {
    constructor() {
        super();
        this._keymap = Clutter.get_default_backend().get_default_seat().get_keymap();
        this._capsLock = this._keymap.get_caps_lock_state();
        this._keymapChanged = this._keymap.connect('state-changed', () => {
            const capsLock = this._keymap.get_caps_lock_state();
            if (capsLock !== this._capsLock) {
                this._capsLock = capsLock;
                this.emit('caps-lock', capsLock);
            }
        });

        this._sources = getInputSourceManager();
        this._sourceChanged = this._sources.connect('current-source-changed', (manager, previous) => {
            // No previous source means the list was just (re)loaded, not switched.
            if (previous && manager.currentSource)
                this.emit('input-source', manager.currentSource);
        });
    }

    destroy() {
        this._keymap.disconnect(this._keymapChanged);
        this._sources.disconnect(this._sourceChanged);
        this.disconnectAll();
    }
}
