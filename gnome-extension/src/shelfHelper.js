// SPDX-License-Identifier: GPL-3.0-or-later

// Drives `isle-shelf`, a small GTK helper window that handles the file
// shelf's drag and drop (which GNOME Shell's own actors cannot do).
//
// The helper is an override-redirect X11 window, so it stacks above the
// island; we place it exactly over the shelf page whenever that page is
// open and the island has finished moving.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const BUS_NAME = 'io.github.isle.ShelfWindow';
const OBJECT_PATH = '/io/github/isle/ShelfWindow';
const ShelfWindowProxy = Gio.DBusProxy.makeProxyWrapper(`
<node><interface name="io.github.isle.ShelfWindow1">
  <method name="Show">
    <arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/>
    <arg name="width" type="i" direction="in"/><arg name="height" type="i" direction="in"/>
  </method>
  <method name="Hide"/>
</interface></node>`);

/** How close (in pixels) a drag must come to the island to open the shelf. */
const DRAG_PROXIMITY = 90;

/**
 * Signals:
 * - `drag-near` (): a file drag came close to the island
 * - `drag-end` (): the drag finished
 */
export class ShelfHelper extends Signals.EventEmitter {
    constructor(island, page) {
        super();
        this._island = island;
        this._page = page;
        this._proxy = null;
        this._shownRect = null;
        this._cancellable = new Gio.Cancellable();

        this._checkAvailable();
        this._watchDrags();
    }

    get available() {
        return this._proxy !== null;
    }

    /** Whether the pointer is over the helper window. */
    containsPointer() {
        if (!this._shownRect)
            return false;
        const [x, y] = global.get_pointer();
        const {x: left, y: top, width, height} = this._shownRect;
        return x >= left && x < left + width && y >= top && y < top + height;
    }

    /** Shows or hides the helper to match the island. Cheap to call often. */
    sync() {
        if (!this._proxy)
            return;
        const rect = this._wantedRect();
        if (!rect) {
            this._hide();
            return;
        }
        const same = this._shownRect &&
            ['x', 'y', 'width', 'height'].every(key => this._shownRect[key] === rect[key]);
        if (same)
            return;
        this._shownRect = rect;
        this._page.helperActive = true;
        this._proxy.ShowRemote(rect.x, rect.y, rect.width, rect.height, (_result, error) => {
            if (!error)
                return;
            console.warn(`Isle: shelf helper failed to show: ${error.message}`);
            // Forget the placement so the next sync tries again.
            this._shownRect = null;
            this._page.helperActive = false;
        });
    }

    /** The shelf page's area on screen, once it is settled and visible. */
    _wantedRect() {
        const page = this._page;
        if (!page.active || !page.visible || !this._island.isSettled ||
            page.translation_x !== 0 || page.opacity !== 255)
            return null;
        const [x, y] = page.get_transformed_position();
        const [width, height] = page.get_transformed_size();
        if (!width || !height)
            return null;
        return {x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height)};
    }

    _hide() {
        if (!this._shownRect)
            return;
        this._shownRect = null;
        this._page.helperActive = false;
        this._proxy?.HideRemote(() => {});
    }

    _checkAvailable() {
        Gio.DBus.session.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListActivatableNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (connection, result) => {
                let names;
                try {
                    [names] = connection.call_finish(result).deep_unpack();
                } catch {
                    return;
                }
                if (!names.includes(BUS_NAME))
                    return;
                // The helper starts on the first call rather than right away.
                ShelfWindowProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, (proxy, error) => {
                    if (error)
                        return;
                    this._proxy = proxy;
                    this.sync();
                }, this._cancellable, Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION);
            });
    }

    /** Opens the shelf when a drag (e.g. a file from Files) nears the island. */
    _watchDrags() {
        this._dnd = global.backend.get_dnd();
        this._dragNear = false;
        this._dndPosition = this._dnd.connect('dnd-position-change', (_dnd, x, y) => {
            if (this._dragNear || !this._proxy)
                return;
            const [left, top] = this._island.get_transformed_position();
            const [width, height] = this._island.get_transformed_size();
            const near = x > left - DRAG_PROXIMITY && x < left + width + DRAG_PROXIMITY &&
                y < top + height + DRAG_PROXIMITY;
            if (near) {
                this._dragNear = true;
                this.emit('drag-near');
            }
        });
        this._dndLeave = this._dnd.connect('dnd-leave', () => {
            if (this._dragNear) {
                this._dragNear = false;
                this.emit('drag-end');
            }
        });
    }

    destroy() {
        this._cancellable.cancel();
        this._dnd.disconnect(this._dndPosition);
        this._dnd.disconnect(this._dndLeave);
        this._hide();
        this._proxy = null;
        this.disconnectAll();
    }
}
