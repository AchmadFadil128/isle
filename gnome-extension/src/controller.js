// SPDX-License-Identifier: GPL-3.0-or-later

// Decides what the island shows and when; see docs/product-spec.md.
//
// The island is in one of three presentations:
//   compact  - the resting pill with the clock and live activities
//   peek     - a short alert (volume, charger, focus timer, new song...)
//   expanded - the full island with pages, while the pointer is on it
//
// Alerts queue up and are shown one at a time; "instant" ones (volume,
// brightness, keyboard, critical notifications) replace whatever is showing.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import * as Alerts from './alerts.js';
import {ClipboardHistory} from './clipboard.js';
import {CompactView} from './compact.js';
import {Daemon} from './daemon.js';
import {DOTS_HEIGHT, ExpandedView, PAGE_HEIGHT} from './expanded.js';
import {Island} from './island.js';
import {AudioOutputs} from './audio.js';
import {FocusMode} from './focusMode.js';
import {NotificationCenter} from './notifications.js';
import {PrivacyMonitor} from './privacy.js';
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
/** Without input for this long, the user is away and animations rest. */
const IDLE_MS = 60 * 1000;

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
const DEFAULT_PAGE_ORDER = ['notifications', 'music', 'focus'];

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
        this._privacy = new PrivacyMonitor(this._daemon);
        this._audio = new AudioOutputs();
        this._focusMode = new FocusMode(this._daemon, this._notifications, this._settings);
        this._clipboard = new ClipboardHistory(this._daemon, this._settings);
        this._island = new Island();
        this._compact = new CompactView(this._daemon, this._settings, this._privacy);
        this._peek = new PeekView();
        this._expanded = this._buildExpanded();
        this._shelf = this._expanded.pageNamed('shelf');
        this._shelfHelper = new ShelfHelper(this._island, this._shelf);

        for (const view of [this._compact, this._peek, this._expanded])
            this._island.addView(view);
        Main.layoutManager.addChrome(this._island, {affectsInputRegion: true, trackFullscreen: true});
        this._connectSignals();
        this._keyboard = new KeyboardWatcher();
        this._keyboard.connect('caps-lock', (_watcher, on) => this._postSystemAlert(Alerts.capsLock(on)));
        this._osd = new OsdHook((icon, label, level, maxLevel) => this._showOsd(icon, label, level, maxLevel));
        this._watchIdle();

        this._updateGeometry();
        this._render();
    }

    _buildExpanded() {
        const size = {height: PAGE_HEIGHT};
        const pages = [
            new MediaPage(this._daemon, this._audio, size),
            new NotificationsPage(this._daemon, this._notifications, size),
            new TimerPage(this._daemon, size),
            new ShelfPage(this._daemon, this._clipboard, this._settings, size),
            new TasksPage(this._daemon, size),
        ];
        for (const page of pages) {
            page.connect('request-keyboard', (_page, wanted) => this._setKeyboard(wanted));
            page.connect('request-close', () => this.collapse());
        }
        const expanded = new ExpandedView(this._daemon, this._privacy, this._settings, pages);
        expanded.connect('page-changed', () => {
            this._pagePickedAt = Date.now();
            this._shelfHelper?.sync();
        });
        expanded.connect('page-settled', () => this._shelfHelper?.sync());
        expanded.pageNamed('shelf').connect('helper-area-changed', () => this._shelfHelper?.sync());
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
        this._shelfHelper.connect('drag-near', () => {
            this._shelf.showTab('files');
            this.expand('shelf');
        });
        this._shelfHelper.connect('drag-end', () => {
            if (!this._island.hover)
                this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
        });

        this._compact.connect('width-changed', () => {
            if (this._presentation === 'compact')
                this._render();
        });

        this._settingsChanged = this._settings.connect('changed::notch-depth', () => this._render());

        this._topBar.connect('height-changed', () => this._updateGeometry());
        this._topBar.connect('calendar-requested', () => this._toggleFromKeyboard());
        island.connect('key-press-event', (_actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this.collapse();
            return Clutter.EVENT_STOP;
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
        daemon.connect('system-event', (_daemon, event) => this._postSystemAlert(Alerts.system(event)));

        this._privacy.connect('recording-started', () =>
            this._post(Alerts.recordingStarted(() => this._privacy.stopRecording())));

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
            // Brings the music player to the front.
            if (!Playback.hasTrack(this._daemon.state.nowPlaying))
                return Clutter.EVENT_PROPAGATE;
            this.collapse();
            this._daemon.call('media', 'Raise');
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    /** Opens the island, on `pageName` or the most useful page. */
    expand(pageName = null) {
        this._cancel('expand');
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

    /**
     * Super+V (GNOME's calendar shortcut, which the island takes over) opens
     * the clipboard history with the search field ready, and holds the
     * island open without the pointer; pressing it again, Esc or a click
     * elsewhere closes it.
     */
    _toggleFromKeyboard() {
        if (this._expandWanted && this._keyboardGrab) {
            this.collapse();
            return;
        }
        this._shelf.showTab('clipboard');
        this.expand('shelf');
        this._setKeyboard(true);
        if (this._keyboardGrab)
            this._shelf.showTab('clipboard', {focusSearch: true});
    }

    /** Grabs the keyboard for typing into the island (e.g. a new task). */
    _setKeyboard(wanted) {
        if (wanted && !this._keyboardGrab) {
            const grab = Main.pushModal(this._island, {actionMode: Shell.ActionMode.POPUP});
            // Another grab (a menu, a dialog) may hold the keyboard already.
            if (!(grab.get_seat_state() & Clutter.GrabState.KEYBOARD)) {
                Main.popModal(grab);
                return;
            }
            this._keyboardGrab = grab;
            // Clicking anywhere else ends typing and closes the island.
            this._stageCapture = global.stage.connect('captured-event', (_stage, event) => {
                if (event.type() === Clutter.EventType.BUTTON_PRESS &&
                    !this._island.contains(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...event.get_coords()))) {
                    this.collapse();
                }
                return Clutter.EVENT_PROPAGATE;
            });
        } else if (!wanted && this._keyboardGrab) {
            // Clear the grab first: releasing it moves key focus, which can
            // make a text field ask to release it again.
            const grab = this._keyboardGrab;
            this._keyboardGrab = null;
            global.stage.disconnect(this._stageCapture);
            Main.popModal(grab);
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
            // Volume and the like are stale by the time the island closes.
            if (!alert.transient)
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
        // Its button does what it says, and that is the end of the alert.
        this._peek.setAlert(alert, () => this._dismissAlert(true));
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
        const alert = Alerts.osd(icon, label, level, maxLevel);
        // Pressing on at 0% or 100% stretches the island like a rubber band.
        const atLimit = alert.level !== null && (alert.level >= 1 || alert.level <= 0);
        const repeated = this._alert?.key === 'osd' && this._alert.title === alert.title &&
            this._alert.level === alert.level;
        this._post(alert);
        if (atLimit && repeated)
            this._island.nudge();
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

    // Idle

    _watchIdle() {
        const monitor = global.backend.get_core_idle_monitor();
        this._idleWatch = monitor.add_idle_watch(IDLE_MS, () => {
            this._compact.idle = true;
            if (!this._activeWatch) {
                this._activeWatch = monitor.add_user_active_watch(() => {
                    this._activeWatch = 0;
                    this._compact.idle = false;
                });
            }
        });
    }

    // Timeouts

    _later(name, ms, callback) {
        if (!this._settings)
            return; // destroyed
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
        // Releasing the keyboard may schedule a collapse; cancel it after.
        this._setKeyboard(false);
        for (const name of [...this._timeouts.keys()])
            this._cancel(name);

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
        // Ending focus mode can turn Do Not Disturb off, which the views
        // still show.
        this._focusMode.destroy();

        // The views listen to the services below, so they go first.
        this._island.destroy();
        this._clipboard.destroy();
        this._privacy.destroy();
        this._audio.destroy();
        this._notifications.destroy();
        this._topBar.destroy();
        this._daemon.destroy();
        this._settings = null;
    }
}
