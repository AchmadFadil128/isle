// SPDX-License-Identifier: GPL-3.0-or-later

// Drives `isle-shelf`, the GTK window over the Files tab that does drag and drop
// (shell actors cannot); started as a drag begins, shown once the island covers it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const BUS_NAME = 'io.github.zickrian.isle.ShelfWindow';
const OBJECT_PATH = '/io/github/zickrian/isle/ShelfWindow';
const ShelfWindowProxy = Gio.DBusProxy.makeProxyWrapper(`
<node><interface name="io.github.zickrian.isle.ShelfWindow1">
  <method name="Show">
    <arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/>
    <arg name="width" type="i" direction="in"/><arg name="height" type="i" direction="in"/>
  </method>
  <method name="ShowOver">
    <arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/>
    <arg name="width" type="i" direction="in"/><arg name="height" type="i" direction="in"/>
    <arg name="ax" type="i" direction="in"/><arg name="ay" type="i" direction="in"/>
    <arg name="awidth" type="i" direction="in"/><arg name="aheight" type="i" direction="in"/>
  </method>
  <method name="Place">
    <arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/>
    <arg name="width" type="i" direction="in"/><arg name="height" type="i" direction="in"/>
    <arg name="ax" type="i" direction="in"/><arg name="ay" type="i" direction="in"/>
    <arg name="awidth" type="i" direction="in"/><arg name="aheight" type="i" direction="in"/>
  </method>
  <method name="Hide"/>
  <method name="SetDropping"><arg name="dropping" type="b" direction="in"/></method>
  <signal name="Dragging"><arg name="active" type="b"/></signal>
  <signal name="Hovering"><arg name="uris" type="as"/></signal>
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

// Signals: `drag-near`, `drag-over` (over the shelf or not), `drag-files` (the URIs over it), `drag-away` (went elsewhere),
// `drag-end` (a drag in or out ended; whether it ended over the shelf), `available-changed`.
export class ShelfHelper extends Signals.EventEmitter {
    constructor(island, page) {
        super();
        this._island = island;
        this._page = page;
        this._proxy = null;
        this._shownRect = null;
        /** Where the files sit in the shown window (the whole window but while a file is dragged in). */
        this._shownArea = null;
        /** A helper from before 1.0.1 has no ShowOver: the window then only ever covers the tab. */
        this._showsOver = true;
        /** One from before 1.0.7 has no Place: its window grows over the island only while a file comes in. */
        this._places = true;
        /** Waiting for the island's shape to cover the whole island before placing the window there. */
        this._awaitingBody = false;
        /** A file is being dragged out of the helper window. */
        this._dragging = false;
        this._cancellable = new Gio.Cancellable();

        this._checkAvailable();
        this._watchDrags();
        // The overview covers windows, this one too: the tab shows its own tiles meanwhile.
        this._overviewIds = ['showing', 'hidden'].map(signal => Main.overview.connect(signal, () => this.sync()));
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

    // Whether the pointer is over the helper or carrying a file out of it: either
    // way the island stays open, since hiding the window would end the drag.
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
        const wanted = this._wantedRect();
        if (!wanted) {
            this._candidate = null;
            // Waiting for the shape to cover the island: looked at again, as no other change may come.
            if (this._awaitingBody && !this._recheck) {
                this._recheck = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RECHECK_MS, () => {
                    this._recheck = 0;
                    this.sync();
                    return GLib.SOURCE_REMOVE;
                });
            }
            // Mid-drag a passing layout change must not take the window from under the file:
            // it would leave and come back, and the light would blink.
            if (Main.overview.visible || !(this._dragNear && this._shownRect && this._page.active && this._page.visible && this._island.mapped))
                this._hide();
            return;
        }
        const {rect, area} = wanted;
        const same = (a, b) => a && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);
        if (same(this._shownRect, rect) && same(this._shownArea, area))
            return;
        // Layout can be off for a frame while opening: a place counts only once the
        // recheck a frame later agrees, never a second call in the same frame.
        if (!same(this._candidate, rect) || !same(this._candidateArea, area) || this._recheck) {
            this._candidate = rect;
            this._candidateArea = area;
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
        this._shownArea = area;
        const shown = (_result, error) => {
            if (!this._proxy) // destroyed meanwhile
                return;
            if (error?.matches(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD) && this._places) {
                this._places = false;
                this._shownRect = this._shownArea = null;
                this.sync();
                return;
            }
            if (error?.matches(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD) && this._showsOver) {
                this._showsOver = false;
                this._shownRect = this._shownArea = null;
                this.sync();
                return;
            }
            if (!error) {
                // The island's own tiles stay until the window is up, so
                // the tab is never blank in between.
                if (this._shownRect)
                    this._page.helperActive = true;
                return;
            }
            console.warn(`Isle: shelf helper failed to show: ${error.message}`);
            // A helper that cannot start (broken install) or hangs (no display) is not
            // retried; the page keeps its own tiles until next login.
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
            this._shownRect = this._shownArea = null;
            this._page.helperActive = false;
        };
        if (this._places)
            this._proxy.PlaceRemote(rect.x, rect.y, rect.width, rect.height, area.x, area.y, area.width, area.height, shown);
        else if (same(rect, area))
            this._proxy.ShowRemote(rect.x, rect.y, rect.width, rect.height, shown);
        else
            this._proxy.ShowOverRemote(rect.x, rect.y, rect.width, rect.height, area.x, area.y, area.width, area.height, shown);
    }

    /** Where the window goes ({rect, area}, the tab's area inside it), once the island's shape covers both; else null.
     * It covers the whole island, so a file lands wherever it is let go; it stays put as one comes in (the helper
     * lets the pointer through outside the tab until then). An older helper covers the island only meanwhile. */
    _wantedRect() {
        const page = this._page;
        const area = page.helperArea;
        if (!area || Main.overview.visible || !page.active || !page.visible || !area.mapped ||
            page.translation_x !== 0 || page.opacity !== 255 || area.opacity !== 255)
            return null;
        // First shown once the shape covers it; after that its last bounces (a moment smaller than it
        // settles) must not take the window down and up again, so it is held while the shape will cover it.
        const held = Boolean(this._shownRect);
        const covers = rect => this._island.covers(rect) || (held && this._island.willCover(rect));
        const tab = this._island.restingRect(area);
        if (!tab?.width || !tab.height || !covers(tab))
            return null;
        // A pixel in from the sides and bottom: the shape's edges can fall between pixels.
        const whole = this._showsOver && (this._places || this._dragNear) ? this._island.restingRect() : null;
        const body = whole && {x: whole.x + 1, y: whole.y, width: whole.width - 2, height: whole.height - 1};
        const inside = body?.width && body.height && covers(body) &&
            tab.x >= body.x && tab.y >= body.y && tab.x + tab.width <= body.x + body.width &&
            tab.y + tab.height <= body.y + body.height;
        // Placed once, where it will stay: not over the tab first and the whole island a frame later. Only while
        // the shape still moves; settled short of it (rounding), it goes over the tab.
        this._awaitingBody = Boolean(this._places && body && !inside && !held && this._island.morphing &&
            this._island.willCover(body));
        if (this._awaitingBody)
            return null;
        return {rect: inside ? body : tab, area: tab};
    }

    _hide() {
        if (!this._shownRect)
            return;
        this._shownRect = this._shownArea = null;
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
                    // Before 1.0 the helper never says; the light keeps its own colours then.
                    this._hoveringId = proxy.connectSignal('Hovering', (_proxy, _sender, [uris]) =>
                        this.emit('drag-files', uris));
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
        this._dragOver = false;
        this._dndPosition = this._dnd.connect('dnd-position-change', (_dnd, x, y) => {
            // Not for a file carried out of the shelf itself.
            if (this._dragging || !this._proxy)
                return;
            this._setDragOver(this._dragNear && this._over(x, y));
            if (!this._dragSeen) {
                this._dragSeen = true;
                this.prepare();
            }
            const distance = this._distanceToIsland(x, y);
            if (!this._dragNear && distance < DRAG_PROXIMITY) {
                this._dragNear = true;
                this._setDropping(true);
                this.emit('drag-near');
                this.sync();
            } else if (this._dragNear && distance > DRAG_AWAY) {
                this._dragNear = false;
                this._setDragOver(false);
                this._setDropping(false);
                this.emit('drag-away');
                this.sync();
            }
        });
        this._dndLeave = this._dnd.connect('dnd-leave', () => {
            this._dragSeen = false;
            if (this._dragNear) {
                // Quietly: the drop's end says where it was let go.
                const over = this._dragOver;
                this._dragNear = this._dragOver = false;
                this._setDropping(false);
                this.emit('drag-end', over);
                // Back to the tab alone, so the island's tabs take clicks again.
                this.sync();
            }
        });
    }

    /** Whether (x, y) is on the shown window, where a drop lands. */
    _over(x, y) {
        const rect = this._shownRect;
        return Boolean(rect) && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
    }

    _setDragOver(over) {
        if (over === this._dragOver)
            return;
        this._dragOver = over;
        this.emit('drag-over', over);
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
        this._overviewIds.forEach(id => Main.overview.disconnect(id));
        this._dnd.disconnect(this._dndPosition);
        this._dnd.disconnect(this._dndLeave);
        this._hide();
        if (this._draggingId) {
            this._signalProxy.disconnectSignal(this._draggingId);
            this._signalProxy.disconnectSignal(this._hoveringId);
            this._signalProxy.disconnect(this._ownerId);
        }
        this._proxy = null;
    }
}
