// SPDX-License-Identifier: GPL-3.0-or-later

// Integration with GNOME Shell itself: the top bar, the volume/brightness
// OSD and keyboard state. Everything here is undone in `destroy()`.

import Clutter from 'gi://Clutter';
import PangoCairo from 'gi://PangoCairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

/**
 * Isle's rule for the top bar's colour, per `top-bar-style`. It is added to
 * whatever inline style the bar has, so other extensions keep theirs; and
 * added back whenever one of them replaces the style (Blur my Shell does).
 * Glass has no colour of its own, like a Mac's menu bar around its notch.
 */
const BAR_STYLES = {
    black: 'background-color: #000000;',
    glass: 'background-color: transparent;',
};
/** Style class giving the glass bar's text a shadow to read on any wallpaper. */
const GLASS_BAR_CLASS = 'isle-glass-bar';
/** Style class setting SF Pro instead of Inter; see stylesheet.css. */
export const SF_PRO_CLASS = 'isle-sf';

/** Whether Apple's SF Pro is installed, to use it instead of Inter. */
export function hasSfPro() {
    return PangoCairo.FontMap.get_default().list_families()
        .some(family => family.get_name() === 'SF Pro Display');
}
/** Style class making the top bar slimmer; see stylesheet.css. */
const COMPACT_BAR_CLASS = 'isle-compact-bar';
/** Style class making the top bar as tall as the closed island. */
const NOTCH_BAR_CLASS = 'isle-notch-bar';

/**
 * Restyles the top bar around the island: paints it black so the island
 * blends in, or see-through like glass, and hides the clock with its
 * calendar menu, since the island shows the time and the notifications.
 *
 * Signals:
 * - `height-changed` ()
 * - `style-changed` (): `blendsIn` may have changed
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
            settings.connect('changed::top-bar-style', () => {
                this._applyStyle();
                this.emit('style-changed');
            }),
            settings.connect('changed::compact-top-bar', () => this._applyStyle()),
            settings.connect('changed::island-in-top-bar', () => this._applyStyle()),
        ];
        this._applyStyle();
        this._styleChanged = Main.panel.connect('notify::style', () => this._syncColor());

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

    /**
     * Whether the bar is as black as the island, so the two read as one
     * shape; otherwise the island hangs from the top of the screen itself.
     */
    get blendsIn() {
        return this._settings.get_string('top-bar-style') === 'black';
    }

    /** Keeps the top bar's centre clear for the island. */
    reserveWidth(width) {
        this._dateMenu.set_width(Math.ceil(width));
    }

    _applyStyle() {
        this._syncColor();
        // The bar's height changes with these; `height-changed` re-lays out the island.
        toggleStyleClass(Main.panel, COMPACT_BAR_CLASS, this._settings.get_boolean('compact-top-bar'));
        toggleStyleClass(Main.panel, NOTCH_BAR_CLASS, this._settings.get_boolean('island-in-top-bar'));
        toggleStyleClass(Main.panel, GLASS_BAR_CLASS, this._settings.get_string('top-bar-style') === 'glass');
        toggleStyleClass(Main.panel, SF_PRO_CLASS, hasSfPro());
    }

    /** Sets Isle's colour rule, leaving the rest of the style alone. */
    _syncColor(barStyle = this._settings.get_string('top-bar-style')) {
        const style = Main.panel.get_style() ?? '';
        const others = Object.values(BAR_STYLES)
            .reduce((rest, rule) => rest.replace(rule, ''), style).trim();
        const rule = BAR_STYLES[barStyle];
        const wanted = rule ? `${others} ${rule}`.trim() : others;
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

        this._syncColor('theme');
        Main.panel.remove_style_class_name(COMPACT_BAR_CLASS);
        Main.panel.remove_style_class_name(NOTCH_BAR_CLASS);
        Main.panel.remove_style_class_name(GLASS_BAR_CLASS);
        Main.panel.remove_style_class_name(SF_PRO_CLASS);
        this._dateMenu.set_width(-1);
        this._dateMenu.opacity = 255;
        this._dateMenu.reactive = true;
    }
}

function toggleStyleClass(actor, name, on) {
    if (on)
        actor.add_style_class_name(name);
    else
        actor.remove_style_class_name(name);
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
