// SPDX-License-Identifier: GPL-3.0-or-later

// Decides what the island shows and when; see docs/product-spec.md.
//
// The island is in one of three presentations:
//   compact  - the resting pill with the clock and live activities
//   peek     - a short alert (volume, charger, reminder, new song...)
//   expanded - the full island with pages, while the pointer is on it
//
// Alerts queue up and are shown one at a time; "instant" ones (volume,
// brightness, keyboard) replace whatever is showing.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import * as Alerts from './alerts.js';
import {CompactView} from './compact.js';
import {Daemon} from './daemon.js';
import {DOTS_HEIGHT, ExpandedView, PAGE_HEIGHT} from './expanded.js';
import {Island} from './island.js';
import {NotificationCenter} from './notifications.js';
import {PEEK_HEIGHT, PEEK_WIDTH, PeekView} from './peek.js';
import * as Playback from './playback.js';
import {KeyboardWatcher, OsdHook, TopBar} from './shell.js';
import {ShelfHelper} from './shelfHelper.js';
import {MediaPage} from './pages/media.js';
import {NotificationsPage} from './pages/notifications.js';
import {ShelfPage} from './pages/shelf.js';
import {TasksPage} from './pages/tasks.js';
import {TimerPage} from './pages/timer.js';

/** The pointer must rest this long before the island opens. */
const EXPAND_DELAY_MS = 120;
/** Grace period before closing when the pointer leaves. */
const COLLAPSE_DELAY_MS = 300;
/** A page picked by hand is kept for this long before smart defaults resume. */
const PAGE_MEMORY_MS = 5 * 60 * 1000;

// Corner and shoulder radii per presentation. The shoulders ("ears") grow
// with the island.
// The compact island hangs 30 px by default: room for its content at a
// comfortable size, a 16 px corner and a 10 px shoulder.
const COMPACT_RADIUS = 16;
const COMPACT_SHOULDER = 10;
const PEEK_RADIUS = 22;
const PEEK_SHOULDER = 13;
const EXPANDED_RADIUS = 32;
const EXPANDED_SHOULDER = 22;

/**
 * Pages that open by default when they have something to show, best first.
 * Notifications only count when some arrived unseen (e.g. during Do Not
 * Disturb), since the others were already shown as alerts.
 */
const DEFAULT_PAGE_ORDER = ['notifications', 'music', 'focus', 'tasks'];

export class Controller {
    constructor(extension) {
        this._settings = extension.getSettings();
        this._daemon = new Daemon();
        this._timeouts = new Map();
        this._presentation = 'compact';
        this._expandWanted = false;
        this._alert = null;
        this._queue = [];
        this._keyboardGrab = null;
        this._pagePickedAt = 0;
        this._lastTrack = null;
        this._tint = null;

        this._topBar = new TopBar(this._settings);
        this._notifications = new NotificationCenter();
        this._island = new Island();
        this._compact = new CompactView(this._daemon, this._settings);
        this._peek = new PeekView();
        this._expanded = this._buildExpanded();
        this._shelfHelper = new ShelfHelper(this._island, this._expanded.pageNamed('shelf'));

        for (const view of [this._compact, this._peek, this._expanded])
            this._island.addView(view);
        Main.layoutManager.addChrome(this._island, {affectsInputRegion: true, trackFullscreen: true});
        this._connectSignals();
        this._keyboard = new KeyboardWatcher();
        this._keyboard.connect('caps-lock', (_watcher, on) => this._postSystemAlert(Alerts.capsLock(on)));
        this._keyboard.connect('input-source', (_watcher, source) => this._postSystemAlert(Alerts.inputSource(source)));
        this._osd = new OsdHook((icon, label, level, maxLevel) => this._showOsd(icon, label, level, maxLevel));
        this._armIdleWatch();

        this._updateGeometry();
        this._render();
    }

    _buildExpanded() {
        const size = {height: PAGE_HEIGHT};
        const pages = [
            new MediaPage(this._daemon, size),
            new NotificationsPage(this._daemon, this._notifications, size),
            new TimerPage(this._daemon, size),
            new ShelfPage(this._daemon, size),
            new TasksPage(this._daemon, size),
        ];
        for (const page of pages) {
            page.connect('request-keyboard', (_page, wanted) => this._setKeyboard(wanted));
            page.connect('request-close', () => this.collapse());
        }
        const expanded = new ExpandedView(this._daemon, pages);
        expanded.connect('page-changed', () => {
            this._pagePickedAt = Date.now();
            this._shelfHelper?.sync();
        });
        // Lyrics widen the island and wash it with the cover's colour.
        expanded.connect('width-changed', () => {
            if (this._presentation === 'expanded')
                this._render();
        });
        expanded.connect('tint-changed', () => this._syncTint());
        return expanded;
    }

    _connectSignals() {
        const island = this._island;
        island.connect('notify::hover', () => this._onHoverChanged());
        island.connect('button-release-event', (_actor, event) => this._onClick(event));
        island.connect('geometry-changed', () => this._shelfHelper.sync());

        // A file dragged towards the island opens the shelf to drop it on.
        this._shelfHelper.connect('drag-near', () => this.expand('shelf'));
        this._shelfHelper.connect('drag-end', () => {
            if (!this._island.hover)
                this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
        });

        this._compact.connect('width-changed', () => {
            if (this._presentation === 'compact')
                this._render();
        });

        this._settingsChanged = this._settings.connect('changed', (_settings, key) => {
            if (key === 'notch-depth')
                this._render();
            else if (key === 'idle-seconds')
                this._armIdleWatch();
        });

        this._topBar.connect('height-changed', () => this._updateGeometry());
        this._topBar.connect('calendar-toggled', (_bar, open) => {
            // The calendar drops down from behind the island; let it show on top.
            const group = Main.layoutManager.uiGroup;
            if (open)
                group.set_child_below_sibling(this._island, this._topBar.calendarActor);
            else
                group.set_child_below_sibling(this._island, global.top_window_group);
        });
        this._monitorsChanged = Main.layoutManager.connect('monitors-changed', () => this._updateGeometry());

        const daemon = this._daemon;
        daemon.connect('changed', (_daemon, key) => {
            if (key === 'nowPlaying')
                this._onNowPlaying();
        });
        daemon.connect('pomodoro-finished', (_daemon, finished, next) => {
            this._chime('complete');
            this._post(Alerts.pomodoroFinished(finished, next, daemon.state.pomodoro, daemon));
        });
        daemon.connect('task-due', (_daemon, id, title) => {
            this._chime('message-new-instant');
            this._post(Alerts.taskDue(id, title, daemon));
        });
        daemon.connect('system-event', (_daemon, event) => this._postSystemAlert(Alerts.system(event)));

        // GNOME's notifications appear in the island instead of as banners.
        const notifications = this._notifications;
        notifications.connect('banner', (_center, notification) => {
            const urgent = notification.urgency === MessageTray.Urgency.CRITICAL;
            this._post(Alerts.notification(notification, urgent));
        });
        notifications.connect('dnd-changed', () => (this._compact.doNotDisturb = notifications.dnd));
        notifications.connect('changed', () => (this._compact.unseenNotifications = notifications.unseenCount > 0));
        this._compact.doNotDisturb = notifications.dnd;
        this._compact.unseenNotifications = notifications.unseenCount > 0;
    }

    // Layout

    _updateGeometry() {
        this._island.topInset = this._topBar.height;
        this._island.monitor = Main.layoutManager.primaryMonitor;
        this._expanded.topInset = this._topBar.height;
        this._render();
    }

    _render() {
        const presentation = this._expandWanted ? 'expanded' : this._alert ? 'peek' : 'compact';
        this._presentation = presentation;
        const top = this._topBar.height;

        // The compact island and alerts hang below the top bar, with their
        // content in the part that hangs down; the open island's header row
        // sits in the top bar itself.
        let size, view;
        switch (presentation) {
        case 'expanded':
            size = {
                width: this._expanded.preferredWidth,
                height: top + PAGE_HEIGHT + DOTS_HEIGHT,
                radius: EXPANDED_RADIUS,
                shoulder: EXPANDED_SHOULDER,
            };
            view = this._expanded;
            break;
        case 'peek':
            size = {width: PEEK_WIDTH, height: top + PEEK_HEIGHT, radius: PEEK_RADIUS, shoulder: PEEK_SHOULDER};
            view = this._peek;
            view.style = `padding-top: ${top}px;`;
            break;
        default:
            size = {
                width: this._compact.preferredWidth,
                height: top + this._settings.get_int('notch-depth'),
                radius: COMPACT_RADIUS,
                shoulder: COMPACT_SHOULDER,
            };
            view = this._compact;
            view.style = `padding-top: ${top}px;`;
        }
        view.set_size(size.width, size.height);
        this._topBar.reserveWidth(this._compact.preferredWidth);
        this._island.morph(size, view);
        this._expanded.setActive(presentation === 'expanded');
        this._syncTint();
        this._shelfHelper.sync();
    }

    _syncTint() {
        const tint = this._presentation === 'expanded' ? this._expanded.tint : null;
        if (tint !== this._tint) {
            this._tint = tint;
            this._island.tint = tint;
        }
    }

    // Pointer

    _onHoverChanged() {
        if (this._island.hover) {
            this._cancel('collapse');
            if (!this._expandWanted)
                this._later('expand', EXPAND_DELAY_MS, () => this.expand());
        } else {
            this._cancel('expand');
            if (this._expandWanted && !this._keyboardGrab)
                this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
        }
    }

    _collapseUnlessHeld() {
        // The shelf helper window covers the island; the pointer may be on it.
        if (this._shelfHelper.containsPointer()) {
            this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
            return;
        }
        this.collapse();
    }

    _onClick(event) {
        switch (event.get_button()) {
        case Clutter.BUTTON_PRIMARY:
            // Clicking a notification opens it, like GNOME's banner did.
            if (!this._expandWanted && this._alert?.onActivate) {
                this._alert.onActivate();
                this._dismissAlert(true);
                return Clutter.EVENT_STOP;
            }
            if (!this._expandWanted) {
                this.expand();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        case Clutter.BUTTON_MIDDLE:
            this._daemon.call('media', 'PlayPause');
            return Clutter.EVENT_STOP;
        case Clutter.BUTTON_SECONDARY:
            this.collapse();
            this._topBar.toggleCalendar();
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    /** Opens the island, on `pageName` or the most useful page. */
    expand(pageName = null) {
        this._cancel('expand');
        this._compact.wake();
        const target = pageName ?? this._alert?.page ?? this._defaultPage();
        if (target)
            this._expanded.showPage(target, {animate: this._expandWanted});
        // Opening the island takes over from the alert being shown.
        this._dismissAlert(false);
        this._expandWanted = true;
        this._render();
    }

    collapse() {
        this._cancel('collapse');
        this._setKeyboard(false);
        if (!this._expandWanted)
            return;
        this._expandWanted = false;
        this._nextAlert();
    }

    /**
     * The page to open on: one with something live to show, else the page
     * last looked at (for a few minutes), else music.
     */
    _defaultPage() {
        const live = DEFAULT_PAGE_ORDER.find(name => this._expanded.pageNamed(name)?.relevant);
        if (live)
            return live;
        if (Date.now() - this._pagePickedAt < PAGE_MEMORY_MS)
            return null; // stay on the current page
        return 'music';
    }

    // Keyboard

    /** Grabs the keyboard for typing into the island (e.g. a new task). */
    _setKeyboard(wanted) {
        if (wanted && !this._keyboardGrab) {
            this._keyboardGrab = Main.pushModal(this._island, {actionMode: Shell.ActionMode.POPUP});
            // Clicking anywhere else ends typing and closes the island.
            this._stageCapture = global.stage.connect('captured-event', (_stage, event) => {
                if (event.type() === Clutter.EventType.BUTTON_PRESS &&
                    !this._island.contains(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...event.get_coords()))) {
                    this.collapse();
                }
                return Clutter.EVENT_PROPAGATE;
            });
        } else if (!wanted && this._keyboardGrab) {
            global.stage.disconnect(this._stageCapture);
            Main.popModal(this._keyboardGrab);
            this._keyboardGrab = null;
            if (!this._island.hover)
                this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
        }
    }

    // Alerts

    /** Shows `alert` now, or queues it behind the one on screen. */
    _post(alert) {
        if (!alert)
            return;
        if (this._alert && this._alert.key === alert.key) {
            this._showAlert(alert); // update in place
            return;
        }
        if (this._expandWanted) {
            // Instant alerts are stale by the time the island closes.
            if (alert.priority !== 'instant')
                this._enqueue(alert);
            return;
        }
        if (this._alert && alert.priority !== 'instant') {
            this._enqueue(alert);
            return;
        }
        if (this._alert && this._alert.priority !== 'instant')
            this._queue.unshift(this._alert); // show it again afterwards
        this._showAlert(alert);
    }

    _postSystemAlert(alert) {
        if (this._settings.get_boolean('system-alerts'))
            this._post(alert);
    }

    _enqueue(alert) {
        this._queue = this._queue.filter(queued => queued.key !== alert.key);
        this._queue.push(alert);
    }

    _showAlert(alert) {
        this._alert = alert;
        this._peek.setAlert(alert);
        this._compact.wake();
        this._later('alert', alert.duration ?? 3000, () => this._dismissAlert(true));
        this._render();
    }

    _dismissAlert(showNext) {
        this._cancel('alert');
        this._alert = null;
        if (showNext)
            this._nextAlert();
    }

    _nextAlert() {
        const next = this._queue.shift();
        if (next && !this._expandWanted)
            this._showAlert(next);
        else
            this._render();
    }

    _showOsd(icon, label, level, maxLevel) {
        if (!this._settings.get_boolean('replace-osd') || !this._island.visible)
            return false;
        // While the island is open the OSD would cover it; let GNOME show it.
        if (this._expandWanted)
            return false;
        this._post(Alerts.osd(icon, label, level, maxLevel));
        return true;
    }

    _onNowPlaying() {
        const nowPlaying = this._daemon.state.nowPlaying;
        const track = Playback.hasTrack(nowPlaying) ? `${nowPlaying.title}\u001f${nowPlaying.artist}` : null;
        const changed = track !== this._lastTrack;
        this._lastTrack = track;
        if (changed && track && Playback.isPlaying(nowPlaying) && this._settings.get_boolean('track-peek'))
            this._post(Alerts.track(nowPlaying));
    }

    _chime(soundName) {
        if (this._settings.get_boolean('chimes'))
            global.display.get_sound_player().play_from_theme(soundName, 'Isle', null);
    }

    // Idle eyes

    _armIdleWatch() {
        const monitor = global.backend.get_core_idle_monitor();
        if (this._idleWatch)
            monitor.remove_watch(this._idleWatch);
        this._idleWatch = monitor.add_idle_watch(this._settings.get_int('idle-seconds') * 1000, () => {
            if (!this._settings.get_boolean('sleepy-eyes') || this._presentation !== 'compact')
                return;
            this._compact.doze();
            if (!this._activeWatch) {
                this._activeWatch = monitor.add_user_active_watch(() => {
                    this._activeWatch = 0;
                    this._compact.wake();
                });
            }
        });
    }

    // Timeouts

    _later(name, ms, callback) {
        this._cancel(name);
        this._timeouts.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _cancel(name) {
        const id = this._timeouts.get(name);
        if (id) {
            GLib.source_remove(id);
            this._timeouts.delete(name);
        }
    }

    destroy() {
        for (const name of [...this._timeouts.keys()])
            this._cancel(name);
        this._setKeyboard(false);

        const monitor = global.backend.get_core_idle_monitor();
        if (this._idleWatch)
            monitor.remove_watch(this._idleWatch);
        if (this._activeWatch)
            monitor.remove_watch(this._activeWatch);

        this._settings.disconnect(this._settingsChanged);
        Main.layoutManager.disconnect(this._monitorsChanged);
        this._osd.destroy();
        this._keyboard.destroy();
        this._shelfHelper.destroy();

        this._island.destroy();
        this._notifications.destroy();
        this._topBar.destroy();
        this._daemon.destroy();
        this._settings = null;
    }
}
