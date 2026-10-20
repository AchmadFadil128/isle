// SPDX-License-Identifier: GPL-3.0-or-later

// Integration with GNOME Shell itself: the top bar, the volume/brightness
// OSD and keyboard state. Everything here is undone in `destroy()`.

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

/**
 * Isle's rule for a black top bar. It is added to whatever inline style the
 * bar has, so other extensions keep theirs; and added back whenever one of
 * them replaces the style (Blur my Shell does, which would otherwise turn
 * the bar see-through around the island).
 */
const BLACK_BAR_STYLE = 'background-color: #000000;';
/** Style class making the top bar slimmer; see stylesheet.css. */
const COMPACT_BAR_CLASS = 'isle-compact-bar';

/**
 * Restyles the top bar around the island: paints it black so the island
 * blends in, and hides the clock with its calendar menu, since the island
 * shows the time and the notifications.
 *
 * Signals:
 * - `height-changed` ()
 * - `calendar-requested` (): the calendar shortcut (Super+V) was pressed
 */
export class TopBar extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._dateMenu = Main.panel.statusArea.dateMenu;
        this._dateMenu.opacity = 0;
        this._dateMenu.reactive = false;

        this._settingsChanged = [
            settings.connect('changed::black-top-bar', () => this._applyStyle()),
            settings.connect('changed::compact-top-bar', () => this._applyStyle()),
        ];
        this._applyStyle();
        this._styleChanged = Main.panel.connect('notify::style', () => this._syncBlack());

        this._heightChanged = Main.panel.connect('notify::height', () => this.emit('height-changed'));

        // The calendar shortcut opens the island instead, and the menu is
        // closed again should anything else open it.
        Main.panel.toggleCalendar = () => this.emit('calendar-requested');
        this._menuChanged = this._dateMenu.menu.connect('open-state-changed', (menu, open) => {
            if (open)
                menu.close();
        });
    }

    get height() {
        return Main.panel.height;
    }

    /** Keeps the top bar's centre clear for the island. */
    reserveWidth(width) {
        this._dateMenu.set_width(Math.ceil(width));
    }

    _applyStyle() {
        this._syncBlack();
        // The bar's height changes with this; `height-changed` re-lays out the island.
        if (this._settings.get_boolean('compact-top-bar'))
            Main.panel.add_style_class_name(COMPACT_BAR_CLASS);
        else
            Main.panel.remove_style_class_name(COMPACT_BAR_CLASS);
    }

    /** Adds or removes Isle's black rule, leaving the rest of the style alone. */
    _syncBlack(black = this._settings.get_boolean('black-top-bar')) {
        const style = Main.panel.get_style() ?? '';
        const others = style.replace(BLACK_BAR_STYLE, '').trim();
        const wanted = black ? `${others} ${BLACK_BAR_STYLE}`.trim() : others;
        // Setting it notifies again, and then nothing changes.
        if (wanted !== style)
            Main.panel.set_style(wanted || null);
    }

    destroy() {
        // Tell no one about changes made while tearing down.
        this.disconnectAll();
        this._settingsChanged.forEach(id => this._settings.disconnect(id));
        Main.panel.disconnect(this._heightChanged);
        Main.panel.disconnect(this._styleChanged);
        this._dateMenu.menu.disconnect(this._menuChanged);
        delete Main.panel.toggleCalendar;

        this._syncBlack(false);
        Main.panel.remove_style_class_name(COMPACT_BAR_CLASS);
        this._dateMenu.set_width(-1);
        this._dateMenu.opacity = 255;
        this._dateMenu.reactive = true;
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
        const original = manager.show;
        // Set when another extension wrapped it before us.
        this._ownOriginal = Object.hasOwn(manager, 'show') ? original : null;
        this._show = function (monitorIndex, icon, label, level, maxLevel) {
            if (handler(icon, label, level, maxLevel))
                return;
            original.call(this, monitorIndex, icon, label, level, maxLevel);
        };
        manager.show = this._show;
    }

    destroy() {
        // Only undo our own override; another extension may have wrapped it
        // since. GNOME's `show` lives on the prototype.
        if (this._manager.show !== this._show)
            return;
        if (this._ownOriginal)
            this._manager.show = this._ownOriginal;
        else
            delete this._manager.show;
    }
}

/** Emits `caps-lock` (on) when Caps Lock is turned on or off. */
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
    }

    destroy() {
        // Tell no one about changes made while tearing down.
        this.disconnectAll();
        this._keymap.disconnect(this._keymapChanged);
    }
}
