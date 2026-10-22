// SPDX-License-Identifier: GPL-3.0-or-later

// Base class for the pages of the expanded island.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

export const Page = GObject.registerClass({
    Signals: {
        // The page needs keyboard input (true) or is done with it (false).
        'request-keyboard': {param_types: [GObject.TYPE_BOOLEAN]},
        // `preferredWidth` changed.
        'width-changed': {},
        // `tint` changed.
        'tint-changed': {},
        // The user did something that should close the island.
        'request-close': {},
        // `hasNews` changed.
        'news-changed': {},
        // `available` changed.
        'availability-changed': {},
        // Changed out of sight: worth laying out before it is next shown (see `markCold`).
        'cold': {},
    },
}, class Page extends St.Widget {
    _init(daemon, params) {
        super._init(params);
        this.daemon = daemon;
        this._active = false;
        this._timeouts = new Map();
        this._daemonHandlers = [];
        /** Whether it changed since last laid out out of sight (see `Expanded.warmPage`). */
        this.cold = true;
        this.connect('destroy', () => this._onPageDestroy());
    }

    /** Pages only animate and poll while they are on screen. */
    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        if (active) {
            this.onActivate();
        } else {
            this.onDeactivate();
            this.cancelAll();
        }
    }

    get active() {
        return this._active;
    }

    /** Whether the page has a tab now; the Call page only has one during a call. */
    get available() {
        return true;
    }

    /** Whether the page has something to show; used to pick a default page. */
    get relevant() {
        return false;
    }

    /** Whether something new waits here; its tab shows a dot. */
    get hasNews() {
        return false;
    }

    /** Island width this page needs, or null for the standard width. */
    get preferredWidth() {
        return null;
    }

    /** RGB colour to wash the island with, or null. */
    get tint() {
        return null;
    }

    /** How `tint` colours the island: 'wash' or 'glow' (see `Island.setTint`). */
    get tintStyle() {
        return 'wash';
    }

    onActivate() {}

    onDeactivate() {}

    /** Readies, while shown out of sight, what its showing would build (see `Expanded.warmPage`). */
    warmUp() {}

    /** Puts away what `warmUp` showed. */
    coolDown() {}

    /** Notes a change made out of sight: its next showing would style and lay it out in the frames it animates. */
    markCold() {
        if (this.cold || this.mapped)
            return;
        this.cold = true;
        this.emit('cold');
    }

    /** Calls `callback` whenever one of the daemon's `keys` changes. */
    watch(keys, callback) {
        this._daemonHandlers.push(this.daemon.connect('changed', (_daemon, key) => {
            if (keys.includes(key)) {
                callback();
                this.markCold();
            }
        }));
    }

    /** Runs `callback` after `ms`, replacing any pending timeout of the same name. */
    later(name, ms, callback) {
        this.cancel(name);
        // An await that ends after the page went (the extension turned off) schedules nothing.
        if (this._destroyed)
            return;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, Math.round(ms)), () => {
            this._timeouts.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.set(name, id);
    }

    cancel(name) {
        const id = this._timeouts.get(name);
        if (id) {
            GLib.source_remove(id);
            this._timeouts.delete(name);
        }
    }

    cancelAll() {
        for (const name of [...this._timeouts.keys()])
            this.cancel(name);
    }

    _onPageDestroy() {
        this._destroyed = true;
        this.cancelAll();
        for (const id of this._daemonHandlers)
            this.daemon.disconnect(id);
        this._daemonHandlers = [];
    }
});
