// SPDX-License-Identifier: GPL-3.0-or-later

// Drives `isle-shelf`, the GTK window over the Files tab that does drag and drop
// (shell actors cannot); started as a drag begins, shown once the island covers it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const BUS_NAME = 'io.github.zickrian.isle.ShelfWindow';
const OBJECT_PATH = '/io/github/zickrian/isle/ShelfWindow';
const ShelfWindowProxy = Gio.DBusProxy.makeProxyWrapper(`
<node><interface name="io.github.zickrian.isle.ShelfWindow1">
  <method name="Show">
    <arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/>
    <arg name="width" type="i" direction="in"/><arg name="height" type="i" direction="in"/>
  </method>
  <method name="Hide"/>
  <method name="SetDropping"><arg name="dropping" type="b" direction="in"/></method>
  <signal name="Dragging"><arg name="active" type="b"/></signal>
</interface></node>`);

/** Errors meaning the helper cannot be started at all. */
const CANNOT_START = [
    Gio.DBusError.SERVICE_UNKNOWN,
    Gio.DBusError.SPAWN_EXEC_FAILED,
    Gio.DBusError.SPAWN_FAILED,
    Gio.DBusError.SPAWN_CHILD_EXITED,
    Gio.DBusError.SPAWN_CHILD_SIGNALED,
];

/** How close (in pixels) a drag must come to the island to open the shelf. */
const DRAG_PROXIMITY = 120;
/** How soon a new place for the window is looked at again; see `sync`. */
const RECHECK_MS = 24;
/** A drag that opened the shelf and then goes this far off closes it again. */
const DRAG_AWAY = 260;

// Signals: `drag-near`, `drag-away` (went elsewhere), `drag-end` (a drag in or out
// ended), `available-changed`.
export class ShelfHelper extends Signals.EventEmitter {
    constructor(island, page) {
        super();
        this._island = island;
        this._page = page;
        this._proxy = null;
        this._shownRect = null;
        /** A file is being dragged out of the helper window. */
        this._dragging = false;
        this._cancellable = new Gio.Cancellable();

        this._checkAvailable();
        this._watchDrags();
    }

    /** Whether the helper is installed, so files can be dropped on the shelf. */
    get available() {
        return this._proxy !== null;
    }

    /** Starts the helper without showing it (pinging its bus name activates it). */
    prepare() {
        if (!this._proxy || this._proxy.g_name_owner || this._preparing)
            return;
        this._preparing = true;
        Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, 'org.freedesktop.DBus.Peer', 'Ping',
            null, null, Gio.DBusCallFlags.NONE, -1, this._cancellable, (connection, result) => {
                this._preparing = false;
                try {
                    connection.call_finish(result);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`Isle: could not start the shelf helper: ${e.message}`);
                }
            });
    }

    /**
     * Whether the pointer is over the helper window, or carrying a file out
     * of it: either way the island must stay open, since hiding the window
     * would end the drag.
     */
    containsPointer() {
        if (this._dragging)
            return true;
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
            this._candidate = null;
            this._hide();
            return;
        }
        const same = (a, b) => a && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);
        if (same(this._shownRect, rect))
            return;
        // A layout can be off for a frame while the island opens: a place
        // is only taken once it holds for two looks a frame apart.
        // Only the recheck, a frame on, may confirm a place: not a second call in this frame.
        if (!same(this._candidate, rect) || this._recheck) {
            this._candidate = rect;
            if (!this._recheck) {
                this._recheck = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RECHECK_MS, () => {
                    this._recheck = 0;
                    this.sync();
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }
        this._shownRect = rect;
        this._proxy.ShowRemote(rect.x, rect.y, rect.width, rect.height, (_result, error) => {
            if (!this._proxy) // destroyed meanwhile
                return;
            if (!error) {
                // The island's own tiles stay until the window is up, so
                // the tab is never blank in between.
                if (this._shownRect)
                    this._page.helperActive = true;
                return;
            }
            console.warn(`Isle: shelf helper failed to show: ${error.message}`);
            // A helper that cannot start (removed, broken install) or hangs
            // (no display to open) is not tried again; the page keeps its
            // own tiles until next login.
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT)) {
                // It may still get to the Show later; a Hide queued behind
                // it keeps the window from staying up for good.
                this._proxy.HideRemote(() => {});
                this._proxy = null;
            } else if (CANNOT_START.some(code => error.matches(Gio.DBusError, code))) {
                this._proxy = null;
            }
            if (!this._proxy)
                this.emit('available-changed');
            // Forget the placement so the next sync tries again.
            this._shownRect = null;
            this._page.helperActive = false;
        });
    }

    /** Where the Files tab will rest, once the island's shape covers it; else null. */
    _wantedRect() {
        const page = this._page;
        const area = page.helperArea;
        if (!area || !page.active || !page.visible || !area.mapped ||
            page.translation_x !== 0 || page.opacity !== 255 || area.opacity !== 255)
            return null;
        const rect = this._island.restingRect(area);
        if (!rect?.width || !rect.height || !this._island.covers(rect))
            return null;
        return rect;
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
                new ShelfWindowProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, (proxy, error) => {
                    if (error)
                        return;
                    this._proxy = proxy;
                    this.emit('available-changed');
                    this._draggingId = proxy.connectSignal('Dragging', (_proxy, _sender, [active]) => {
                        this._dragging = active;
                        // Dropped somewhere, or nowhere: the island may close now.
                        if (!active)
                            this.emit('drag-end');
                    });
                    this._signalProxy = proxy;
                    // A helper that quits mid-drag never says the drag ended.
                    this._ownerId = proxy.connect('notify::g-name-owner', () => {
                        if (this._dragging && !proxy.g_name_owner) {
                            this._dragging = false;
                            this.emit('drag-end');
                        }
                    });
                    this.sync();
                }, this._cancellable, Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION);
            });
    }

    /** Opens the shelf when a drag nears the island; closes it if the drag goes elsewhere. */
    _watchDrags() {
        this._dnd = global.backend.get_dnd();
        this._dragNear = false;
        this._dragSeen = false;
        this._dndPosition = this._dnd.connect('dnd-position-change', (_dnd, x, y) => {
            // Not for a file carried out of the shelf itself.
            if (this._dragging || !this._proxy)
                return;
            if (!this._dragSeen) {
                this._dragSeen = true;
                this.prepare();
            }
            const distance = this._distanceToIsland(x, y);
            if (!this._dragNear && distance < DRAG_PROXIMITY) {
                this._dragNear = true;
                this._setDropping(true);
                this.emit('drag-near');
            } else if (this._dragNear && distance > DRAG_AWAY) {
                this._dragNear = false;
                this._setDropping(false);
                this.emit('drag-away');
            }
        });
        this._dndLeave = this._dnd.connect('dnd-leave', () => {
            this._dragSeen = false;
            if (this._dragNear) {
                this._dragNear = false;
                this._setDropping(false);
                this.emit('drag-end');
            }
        });
    }

    /** How far (x, y) is from the island; 0 on it, or above it in the top bar. */
    _distanceToIsland(x, y) {
        const [left, top] = this._island.get_transformed_position();
        const [width, height] = this._island.get_transformed_size();
        const dx = Math.max(left - x, 0, x - (left + width));
        const dy = Math.max(top - y, 0, y - (top + height));
        return Math.hypot(dx, dy);
    }

    /** Tells the helper a file is on its way, so it shows where it will land. */
    _setDropping(dropping) {
        // A helper from before 0.2 has no such method; it just does without.
        this._proxy?.SetDroppingRemote(dropping, () => {});
    }

    destroy() {
        // Tell no one about changes made while tearing down.
        this.disconnectAll();
        if (this._recheck)
            GLib.source_remove(this._recheck);
        this._cancellable.cancel();
        this._dnd.disconnect(this._dndPosition);
        this._dnd.disconnect(this._dndLeave);
        this._hide();
        if (this._draggingId) {
            this._signalProxy.disconnectSignal(this._draggingId);
            this._signalProxy.disconnect(this._ownerId);
        }
        this._proxy = null;
    }
}
