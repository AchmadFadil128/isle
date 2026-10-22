// SPDX-License-Identifier: GPL-3.0-or-later

// Decides what the island shows and when (compact, peek or expanded); see docs/product-spec.md.
// Alerts show one at a time; "instant" ones (volume, brightness, critical...) replace what is showing.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import * as Alerts from './alerts.js';
import {ClipboardHistory} from './clipboard.js';
import {CompactView} from './compact.js';
import {grabsKeyboard} from './compat.js';
import {Daemon} from './daemon.js';
import {BOTTOM_PADDING, ExpandedView, PAGE_HEIGHT} from './expanded.js';
import {Island} from './island.js';
import {AudioOutputs} from './audio.js';
import {CallMonitor} from './call.js';
import {FocusMode} from './focusMode.js';
import {NotificationCenter} from './notifications.js';
import {PrivacyMonitor} from './privacy.js';
import {PeekView} from './peek.js';
import * as Playback from './playback.js';
import {KeyboardWatcher, OsdHook, SF_PRO_CLASS, TopBar, hasSfPro} from './shell.js';
import {ShelfHelper} from './shelfHelper.js';
import {CallPage} from './pages/call.js';
import {CalendarPage} from './pages/calendar.js';
import {FocusPage} from './pages/focus.js';
import {MediaPage} from './pages/media.js';
import {NotificationsPage} from './pages/notifications.js';
import {ShelfPage} from './pages/shelf.js';
import {UsagePage} from './pages/usage.js';
import {ReminderWatcher} from './reminders.js';
import {GREETING, InstalledApps, SIRI_COLORS, VoiceView, actionTypes, aiSettings, openSignIn, runActions, stopPending, voiceContext} from './voice.js';
import {TextWriter} from './writer.js';

/** The pointer must rest this long before the island opens, moving at most this far meanwhile. */
const EXPAND_DELAY_MS = 120;
const REST_DISTANCE_PX = 10;
/** The views and pages are laid out ahead this long after starting, a step at a time (see `_warmUp`). */
const WARM_START_MS = 3000;
const WARM_STEP_MS = 60;
/** And again this long after the island closes, or a page changes out of sight, while it stays closed. */
const WARM_AFTER_CLOSE_MS = 1500;
/** Outside an island that shrank under it, the pointer is checked this often, and left this long. */
const MOVE_CHECK_MS = 250;
const STILL_OUTSIDE_MS = 30000;
/** Grace period before closing when the pointer leaves. */
const COLLAPSE_DELAY_MS = 300;
/** A page picked by hand is kept for this long before smart defaults resume. */
const PAGE_MEMORY_MS = 5 * 60 * 1000;
/** An alert's width is checked again this soon after it shows. */
const ALERT_FIT_DELAY_MS = 60;
/** Without input for this long, the user is away and animations rest. */
const IDLE_MS = 60 * 1000;

// Corner and shoulder ("ear") radii per presentation; the shoulders grow with the island.
// The compact island hangs 30 px by default, with a 16 px corner and a 10 px shoulder.
const COMPACT_RADIUS = 16;
const COMPACT_SHOULDER = 10;
// Inside the top bar the closed island is a small notch. Its shoulders only show on a bar that is
// not black, where it hangs from the screen's top edge.
const IN_BAR_RADIUS = 10;
const IN_BAR_SHOULDER = 7;
const PEEK_RADIUS = 22;
// Off a black bar an alert has no bar to fill, so it starts this far below
// the screen's top instead of below the bar.
const PEEK_TOP_GLASS = 6;
const PEEK_SHOULDER = 13;
const EXPANDED_RADIUS = 32;
const EXPANDED_SHOULDER = 22;
const VOICE_RADIUS = 26;

/** A question back is shown this long before the island listens for the reply. */
const VOICE_LISTEN_AGAIN_MS = 900;
/** It listens by itself at most this many times in a row; a noisy room can't keep it open. */
const VOICE_MAX_AUTO_LISTENS = 2;
/** How long an answer stays: one that did something, one to read (by its length), and an error. */
const VOICE_DONE_MS = 2500;
const VOICE_READ_MS = {base: 3000, perChar: 45, max: 12000};
const VOICE_ERROR_MS = 4000;
/** Once read with the pointer on it, an answer goes this soon after the pointer leaves. */
const VOICE_LEAVE_MS = 1200;

// Pages that open by default when they have something to show, best first, unless one was picked
// by hand lately. Notifications count only when some arrived unseen (others were shown as alerts).
const DEFAULT_PAGE_ORDER = ['call', 'notifications', 'music', 'focus'];

export class Controller {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._daemon = new Daemon();
        this._timeouts = new Map();
        this._presentation = 'compact';
        /** Whether `_warmUp` shows the open island's view out of sight. */
        this._warmShown = false;
        this._expandWanted = false;
        this._alert = null;
        this._queue = [];
        this._keyboardGrab = null;
        this._pagePickedAt = 0;
        this._lastTrack = null;
        this._tint = null;
        this._tintStyle = null;
        this._voiceOpen = false;
        this._voiceBound = false;
        /** Counts `_listen` calls, so only the latest sends its request. */
        this._listenRequest = 0;
        this._voiceCloseMs = VOICE_ERROR_MS;
        /** The last answer whose actions ran. */
        this._voiceTurn = 0;
        /** Times in a row it listened again by itself; see `VOICE_MAX_AUTO_LISTENS`. */
        this._autoListens = 0;
        /** The window in front when the assistant opened, for it to write into. */
        this._voiceTarget = null;
        /** Actions waiting for the island to close; see `closeThen`. */
        this._voiceAfter = [];
        /** The window text was last selected in, so a selection only goes to the AI from where it was made. */
        this._selectedIn = null;
        this._primaryChanged = global.display.get_selection().connect('owner-changed', (_selection, type) => {
            if (type === Meta.SelectionType.SELECTION_PRIMARY)
                this._selectedIn = global.display.focus_window;
        });
        // Clicking into a window, or one an action opened, puts an answer away.
        this._focusChanged = global.display.connect('notify::focus-window', () => {
            const focus = global.display.focus_window;
            if (this._voiceOpen && this._voiceAnswered && focus && focus !== this._voiceTarget)
                this.collapse();
        });

        this._topBar = new TopBar(this._settings);
        this._notifications = new NotificationCenter();
        this._privacy = new PrivacyMonitor(this._daemon);
        this._call = new CallMonitor(this._privacy, this._settings);
        this._audio = new AudioOutputs();
        this._focusMode = new FocusMode(this._daemon, this._notifications, this._settings);
        this._clipboard = new ClipboardHistory(this._daemon, this._settings);
        this._writer = new TextWriter(this._clipboard);
        this._island = new Island();
        if (hasSfPro())
            this._island.add_style_class_name(SF_PRO_CLASS);
        this._compact = new CompactView(this._daemon, this._settings, this._privacy, this._call);
        // Two, taking turns: a new alert fades in over the one it replaces, rather than swapping in a frame.
        this._peeks = [new PeekView(), new PeekView()];
        this._peek = this._peeks[0];
        this._voice = new VoiceView();
        this._expanded = this._buildExpanded();
        this._shelf = this._expanded.pageNamed('shelf');
        this._shelfHelper = new ShelfHelper(this._island, this._shelf);

        for (const view of [this._compact, ...this._peeks, this._expanded, this._voice])
            this._island.addView(view);
        Main.layoutManager.addChrome(this._island, {trackFullscreen: true});
        this._connectSignals();
        this._keyboard = new KeyboardWatcher();
        this._keyboard.connect('caps-lock', (_watcher, on) => this._postSystemAlert(Alerts.capsLock(on)));
        this._osd = new OsdHook((icon, label, level, maxLevel) => this._showOsd(icon, label, level, maxLevel));
        this._watchIdle();
        this._installedApps = new InstalledApps();
        this._reminders = new ReminderWatcher(this._daemon, reminder => {
            this._chime('complete');
            this._post(Alerts.reminder(reminder));
        });
        this._syncVoiceEnabled();
        this._syncUsage();

        this._updateGeometry();
        this._render();
        this._later('warm', WARM_START_MS, () => this._warmUp(true));
    }

    _buildExpanded() {
        const size = {height: PAGE_HEIGHT};
        const pages = [
            new CallPage(this._daemon, this._call, this._privacy, this._settings, size),
            new MediaPage(this._daemon, this._audio, size),
            new NotificationsPage(this._daemon, this._notifications, size),
            new FocusPage(this._daemon, size),
            new ShelfPage(this._daemon, this._clipboard, this._settings, size),
            new CalendarPage(this._daemon, size),
            new UsagePage(this._daemon, size),
        ];
        for (const page of pages) {
            page.connect('request-keyboard', (_page, wanted) => this._setKeyboard(wanted));
            page.connect('request-close', () => this.collapse());
            page.connect('cold', () => this._scheduleWarm());
        }
        const expanded = new ExpandedView(this._daemon, this._privacy, this._call, this._settings, pages);
        expanded.connect('page-changed', () => {
            // Picked by hand (a tab, a swipe) while open; not when opening, nor when a page
            // (the call's) goes away by itself.
            if (this._expandWanted && expanded.pickedByHand)
                this._pagePickedAt = Date.now();
            if (expanded.page === this._shelf)
                this._shelfHelper?.prepare();
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
        expanded.connect('voice-requested', () => this._openVoice());
        // Settings open in their own window; the island gets out of its way.
        expanded.connect('settings-requested', () => {
            this.collapse();
            this._extension.openPreferences();
        });
        return expanded;
    }

    _connectSignals() {
        const island = this._island;
        island.connect('notify::hovered', () => this._onHoverChanged());
        // Hidden (under a fullscreen window), nothing can be laid out: it waits until shown again.
        island.connect('notify::mapped', () => this._scheduleWarm());
        island.connect('button-release-event', (_actor, event) => this._onClick(event));
        island.connect('geometry-changed', () => this._shelfHelper.sync());

        // A file dragged towards the island opens the shelf to drop it on.
        this._shelfHelper.connect('drag-near', () => {
            this._shelf.showTab('files');
            this._shelf.dropping = true;
            this.expand('shelf');
            // The shelf stays the page to open on, to drag the files out again.
            this._pagePickedAt = Date.now();
        });
        this._shelfHelper.connect('drag-end', () => {
            this._shelf.dropping = false;
            if (!this._island.hovered)
                this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
        });
        // It went elsewhere after all.
        this._shelfHelper.connect('drag-away', () => {
            this._shelf.dropping = false;
            this._collapseUnlessHeld();
        });
        this._shelfHelper.connect('available-changed', () =>
            (this._shelf.helperAvailable = this._shelfHelper.available));

        this._compact.connect('width-changed', () => {
            if (this._presentation === 'compact')
                this._render();
        });

        this._settingsChanged = ['notch-depth', 'island-in-top-bar'].map(key =>
            this._settings.connect(`changed::${key}`, () => this._render()));
        this._settingsChanged.push(this._settings.connect('changed::voice-assistant', () => this._syncVoiceEnabled()));
        for (const key of ['usage-enabled', 'usage-claude', 'usage-codex', 'usage-warn', 'usage-critical'])
            this._settingsChanged.push(this._settings.connect(`changed::${key}`, () => this._syncUsage()));

        this._topBar.connect('height-changed', () => this._updateGeometry());
        this._topBar.connect('style-changed', () => this._updateGeometry());
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
            else if (key === 'assistant')
                this._onAssistant();
        });
        daemon.connect('voice-level', (_daemon, level) => this._voice.setLevel(level));
        daemon.connect('assistant-lost', () => this._onAssistantLost());
        daemon.connect('usage-alert', (_daemon, provider, window, percent, resetsAt) =>
            this._post(Alerts.usage(provider, window, percent, resetsAt, this._settings.get_int('usage-critical'))));
        // isled forgets the settings when it restarts; they are sent again whenever it appears.
        daemon.connect('changed', (_daemon, key) => {
            if (key === 'usage' && this._daemon.state.usage === null)
                this._usageSent = false;
            if (key === 'usage' && !this._usageSent)
                this._syncUsage();
        });
        this._voice.connect('orb-clicked', () => this._onVoiceKey());
        // An AI's CLI signs in from a terminal; the island gets out of its way.
        this._voice.connect('sign-in', () => {
            if (openSignIn(this._daemon.state.assistant?.provider))
                this.collapse();
        });
        this._voice.connect('frame', (_view, time, level) => this._island.setTintMotion(time, level));
        daemon.connect('pomodoro-finished', (_daemon, finished, next) => {
            this._chime('complete');
            this._post(Alerts.pomodoroFinished(finished, next, daemon.state.pomodoro, daemon));
        });
        daemon.connect('system-event', (_daemon, event) => this._postSystemAlert(Alerts.system(event)));

        this._privacy.connect('recording-started', () =>
            this._post(Alerts.recordingStarted(() => this._privacy.stopRecording())));
        // A new call is what the island opens on next, whatever was picked before.
        this._call.connect('started', () => (this._pagePickedAt = 0));

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
        // On a black bar the island grows out of it, its shoulders below the
        // bar; on any other it hangs from the top of the screen like a notch.
        this._island.topInset = this._topBar.blendsIn ? this._topBar.height : 0;
        this._island.monitor = Main.layoutManager.primaryMonitor;
        this._expanded.topInset = this._topBar.height;
        this._render();
    }

    _render() {
        const presentation = this._voiceOpen ? 'voice'
            : this._expandWanted ? 'expanded' : this._alert ? 'peek' : 'compact';
        this._presentation = presentation;
        if (presentation !== 'compact')
            this._putAwayWarm();
        const top = this._topBar.height;
        const inBar = this._settings.get_boolean('island-in-top-bar');
        // Before measuring it: inside the bar it is smaller.
        this._compact.inBar = inBar;

        // Alerts hang below the top bar; the open island's header sits in the bar. The compact island
        // either hangs too or sits inside the bar like a MacBook's notch, covering no window.
        let size, view;
        switch (presentation) {
        case 'expanded':
            size = {
                width: this._expanded.preferredWidth,
                height: top + PAGE_HEIGHT + BOTTOM_PADDING,
                radius: EXPANDED_RADIUS,
                shoulder: EXPANDED_SHOULDER,
            };
            view = this._expanded;
            break;
        case 'voice': {
            // Like an alert, it hangs below the bar (or near the top of the screen).
            const inset = this._topBar.blendsIn ? top : PEEK_TOP_GLASS;
            size = {width: this._voice.preferredWidth, height: inset + this._voice.fit(), radius: VOICE_RADIUS, shoulder: PEEK_SHOULDER};
            view = this._voice;
            view.style = `padding-top: ${inset}px;`;
            break;
        }
        case 'peek': {
            const inset = this._topBar.blendsIn ? top : PEEK_TOP_GLASS;
            size = {width: this._peek.preferredWidth, height: inset + this._peek.preferredHeight, radius: PEEK_RADIUS, shoulder: PEEK_SHOULDER};
            view = this._peek;
            view.style = `padding-top: ${inset}px;`;
            break;
        }
        default:
            size = {
                width: this._compact.preferredWidth,
                height: inBar ? top : top + this._settings.get_int('notch-depth'),
                radius: inBar ? IN_BAR_RADIUS : COMPACT_RADIUS,
                shoulder: inBar ? IN_BAR_SHOULDER : COMPACT_SHOULDER,
            };
            view = this._compact;
            view.style = inBar ? null : `padding-top: ${top}px;`;
        }
        view.set_size(size.width, size.height);
        this._topBar.reserveWidth(this._compact.preferredWidth);
        this._island.morph(size, view);
        this._expanded.setActive(presentation === 'expanded');
        this._voice.setActive(presentation === 'voice');
        this._syncTint();
        // Have the helper running before it is needed: starting takes a moment.
        if (presentation === 'expanded' && this._expanded.page === this._shelf)
            this._shelfHelper.prepare();
        this._shelfHelper.sync();
    }

    /**
     * Lays out ahead, while closed and a step at a time, what would otherwise be styled and laid out in the
     * frames that show it: the pages that changed out of sight, and with `all` the alerts' and voice's views.
     */
    _warmUp(all) {
        const island = this._island;
        const expanded = this._expanded;
        if (!island.mapped)
            return;
        const pages = expanded.pages.filter(page => page.cold);
        const steps = all
            ? [...this._peeks, this._voice].map(view => () => island.warmView(view, true) && island.warmView(view, false))
            : [];
        if (pages.length || all) {
            steps.push(() => {
                this._warmShown = island.warmView(expanded, true);
                expanded.warmTabs();
            });
            // Each page stays shown until the next step, so a frame lays it out too.
            pages.forEach((page, i) => steps.push(() => {
                if (!this._warmShown)
                    return;
                if (i)
                    expanded.warmPage(pages[i - 1], false);
                expanded.warmPage(page, true);
            }));
            steps.push(() => this._putAwayWarm());
        }
        const next = () => {
            // Opened meanwhile (see `_render`): the rest waits.
            if (this._presentation !== 'compact') {
                this._later('warm', WARM_START_MS, () => this._warmUp(all));
                return;
            }
            steps.shift()?.();
            if (steps.length)
                this._later('warm', WARM_STEP_MS, next);
            else
                this._scheduleWarm();
        };
        next();
    }

    /** Hides what `_warmUp` showed out of sight. */
    _putAwayWarm() {
        if (!this._warmShown)
            return;
        this._warmShown = false;
        this._expanded.hideWarmPages();
        this._island.warmView(this._expanded, false);
    }

    /** Lays out the pages that changed out of sight, once the island has rested closed a while. */
    _scheduleWarm() {
        if (this._presentation === 'compact' && this._island.mapped && !this._timeouts.has('warm') &&
            this._expanded.pages.some(page => page.cold))
            this._later('warm', WARM_AFTER_CLOSE_MS, () => this._warmUp(false));
    }

    _syncTint() {
        const expanded = this._presentation === 'expanded';
        const voice = this._presentation === 'voice';
        const tint = voice ? SIRI_COLORS : expanded ? this._expanded.tint : null;
        const style = voice ? 'siri' : expanded ? this._expanded.tintStyle : null;
        if (tint !== this._tint || style !== this._tintStyle) {
            this._tint = tint;
            this._tintStyle = style;
            this._island.setTint(tint, style);
        }
    }

    // Pointer

    _onHoverChanged() {
        // An answer stays while the pointer is on it, and as long again once it leaves.
        if (this._voiceOpen) {
            if (this._island.hovered)
                this._cancel('voice-close');
            else
                this._scheduleVoiceClose(Math.min(this._voiceCloseMs, VOICE_LEAVE_MS));
            return;
        }
        if (this._island.hovered) {
            this._cancel('collapse');
            if (!this._expandWanted)
                this._expandOnRest();
        } else {
            this._cancel('expand');
            if (!this._expandWanted || this._keyboardGrab)
                return;
            // Shrinking under a still pointer is no reason to close: wait until it moves.
            if (this._island.morphing)
                this._collapseOnMove(global.get_pointer());
            else
                this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
        }
    }

    // Opens once the pointer rests on the island, so passing over it along the top bar opens nothing.
    _expandOnRest() {
        const [x, y] = global.get_pointer();
        this._later('expand', EXPAND_DELAY_MS, () => {
            const [nowX, nowY] = global.get_pointer();
            if (Math.hypot(nowX - x, nowY - y) <= REST_DISTANCE_PX)
                this.expand();
            else if (this._island.hovered)
                this._expandOnRest();
        });
    }

    // Closes after the pointer, outside the island, moves away from `[x, y]`, or has rested there a while.
    _collapseOnMove([x, y], waited = 0) {
        this._later('collapse', MOVE_CHECK_MS, () => {
            const [nowX, nowY] = global.get_pointer();
            if (Math.hypot(nowX - x, nowY - y) > 2 || waited >= STILL_OUTSIDE_MS)
                this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
            else
                this._collapseOnMove([x, y], waited + MOVE_CHECK_MS);
        });
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
        // A click puts an answer away; the face and the Sign in button take their own clicks.
        if (this._voiceOpen) {
            if (!this._voiceAnswered)
                return Clutter.EVENT_PROPAGATE;
            this.collapse();
            return Clutter.EVENT_STOP;
        }
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
            // Brings the call, or else the music player, to the front from the closed island
            // (the open one has its own controls, cards and fields).
            if (this._expandWanted)
                return Clutter.EVENT_PROPAGATE;
            if (this._call.active) {
                this._call.raise();
                return Clutter.EVENT_STOP;
            }
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
        if (this._voiceOpen)
            this._closeVoice();
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
        // Once closed and settled, what changed meanwhile is laid out for next time (see `_warmUp`).
        this._later('warm', WARM_AFTER_CLOSE_MS, () => this._warmUp(true));
        if (this._voiceOpen) {
            this._closeVoice();
            this._nextAlert();
            return;
        }
        if (!this._expandWanted)
            return;
        this._expandWanted = false;
        this._nextAlert();
    }

    /** The page to open on: the one picked lately by hand, else one with something live, else music. */
    _defaultPage() {
        if (Date.now() - this._pagePickedAt < PAGE_MEMORY_MS)
            return null; // stay on the current page
        return DEFAULT_PAGE_ORDER.find(name => this._expanded.pageNamed(name)?.relevant) ?? 'music';
    }

    // Keyboard

    // Super+V (GNOME's calendar shortcut, taken over) opens the clipboard history, search ready, and
    // holds the island open without the pointer; Super+V again, Esc or a click elsewhere closes it.
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
            if (!grabsKeyboard(grab)) {
                Main.popModal(grab);
                return;
            }
            this._keyboardGrab = grab;
            // Clicking anywhere else ends typing and closes the island.
            this._stageCapture = global.stage.connect('captured-event', (_stage, event) => {
                // The shelf helper's window lies over the island: inside too.
                if (event.type() === Clutter.EventType.BUTTON_PRESS && !this._shelfHelper.containsPointer() &&
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
            // An open assistant closes on its own timer.
            if (!this._island.hovered && !this._voiceOpen)
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
        if (this._expandWanted || this._voiceOpen) {
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
        // Another alert on screen takes the other view; the same one (the volume moving) updates in place.
        if (this._presentation === 'peek' && this._shownAlertKey !== alert.key)
            this._peek = this._peeks[1 - this._peeks.indexOf(this._peek)];
        this._shownAlertKey = alert.key;
        this._alert = alert;
        // Its button does what it says, and that is the end of the alert.
        this._peek.setAlert(alert, () => this._dismissAlert(true));
        this._later('alert', alert.duration ?? 3000, () => this._dismissAlert(true));
        this._render();
        // Parts shown for the first time are only measured right once styled;
        // fit the island again then.
        this._later('alert-fit', ALERT_FIT_DELAY_MS, () => {
            if (this._presentation === 'peek')
                this._render();
        });
    }

    _dismissAlert(showNext) {
        this._cancel('alert');
        this._alert = null;
        if (showNext)
            this._nextAlert();
    }

    _nextAlert() {
        const next = this._queue.shift();
        if (next && !this._expandWanted && !this._voiceOpen)
            this._showAlert(next);
        else
            this._render();
    }

    _showOsd(icon, label, level, maxLevel) {
        if (!this._settings.get_boolean('replace-osd') || !this._island.visible)
            return false;
        // While the island is open the OSD would cover it; let GNOME show it.
        if (this._expandWanted || this._voiceOpen)
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

    // Usage

    /** Sends the usage settings to isled, and the warning marks to the page. */
    _syncUsage() {
        const config = {
            enabled: this._settings.get_boolean('usage-enabled'),
            claude: this._settings.get_boolean('usage-claude'),
            codex: this._settings.get_boolean('usage-codex'),
            warn: this._settings.get_int('usage-warn'),
            critical: this._settings.get_int('usage-critical'),
        };
        this._expanded.pageNamed('usage')?.setMarks(config.warn, config.critical);
        this._usageSent = true;
        this._daemon.call('usage', 'SetConfig', JSON.stringify(config));
    }

    // Voice

    /** Binds the shortcut and shows the mic button while the assistant is turned on. */
    _syncVoiceEnabled() {
        const enabled = this._settings.get_boolean('voice-assistant');
        if (enabled && !this._voiceBound) {
            Main.wm.addKeybinding('voice-shortcut', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
                () => this._onVoiceKey());
        } else if (!enabled && this._voiceBound) {
            Main.wm.removeKeybinding('voice-shortcut');
            if (this._voiceOpen)
                this.collapse();
        }
        this._voiceBound = enabled;
        this._expanded.voiceEnabled = enabled;
    }

    // The shortcut (or the face) opens the assistant listening; while listening it finishes,
    // and once answered it listens again for a follow-up.
    _onVoiceKey() {
        if (!this._voiceOpen) {
            this._openVoice();
            return;
        }
        // isled's phase, not the view's: the view says listening before isled has started.
        const phase = this._daemon.state.assistant?.phase;
        if (phase === 'listening')
            this._daemon.call('assistant', 'Stop');
        else if (this._voiceAnswered) {
            this._autoListens = 0;
            this._listen();
        }
    }

    _openVoice() {
        if (!this._voiceBound)
            return;
        // Opened again before the last answer's actions ran: they belonged to that one.
        this._cancel('voice-after');
        this._voiceAfter = [];
        this._voiceTarget = global.display.focus_window;
        this._cancel('expand');
        this._cancel('collapse');
        this._expandWanted = false;
        if (this._alert && !this._alert.transient)
            this._queue.unshift(this._alert);
        this._dismissAlert(false);
        this._voiceOpen = true;
        this._voiceTurn = this._daemon.state.assistant?.turn ?? 0;
        this._autoListens = 0;
        this._listen({greet: true});
    }

    async _listen({greet = false} = {}) {
        // Read before the keyboard is taken, while the selection is surely the app's.
        // The app list only matters to a conversation's first request.
        const apps = greet ? this._installedApps.names : [];
        const context = voiceContext(this._settings, this._notifications, {apps, selectedIn: this._selectedIn});
        const request = ++this._listenRequest;
        this._cancel('voice-close');
        this._cancel('voice-listen');
        // A follow-up shows what was just said back, one dim line above "Listening…".
        this._voice.followUp = greet ? null : this._voice.exchange?.reply || null;
        // Esc and clicks elsewhere close it while it listens and thinks.
        this._setKeyboard(true);
        this._voice.greeting = greet ? GREETING : null;
        this._voice.setState({phase: 'listening'});
        this._render();
        let json;
        try {
            json = await context;
        } catch (e) {
            // Never left listening for nothing: ask without the extras.
            console.warn(`Isle: could not gather the request's context: ${e.message}`);
            json = JSON.stringify({
                ...aiSettings(this._settings),
                actions: actionTypes(),
                whisper_model: this._settings.get_string('voice-speech-model'),
                language: this._settings.get_string('voice-language'),
            });
        }
        // Closed, or asked to listen again, meanwhile.
        if (this._voiceOpen && request === this._listenRequest)
            this._daemon.call('assistant', 'Listen', json);
    }

    _onAssistant() {
        const state = this._daemon.state.assistant;
        if (!this._voiceOpen || !state || state.phase === 'idle')
            return;
        // Nothing said back to a follow-up: it just closes, no error.
        if (state.phase === 'error' && state.heard_nothing && this._voice.followUp) {
            this.collapse();
            return;
        }
        this._voice.setState(state);
        this._render();
        // New text is only measured right once styled; fit the island again then.
        this._later('voice-fit', ALERT_FIT_DELAY_MS, () => {
            if (this._presentation === 'voice')
                this._render();
        });
        // Once answered, typing goes back to the windows; the answer closes on its own.
        if (state.phase === 'reply' || state.phase === 'error')
            this._setKeyboard(false);
        if (state.phase === 'reply' && state.turn !== this._voiceTurn) {
            this._voiceTurn = state.turn;
            runActions(state.actions, this._voiceActions());
            if (state.listen && this._autoListens < VOICE_MAX_AUTO_LISTENS) {
                this._autoListens++;
                // Asked something back: listen for the reply without a key press.
                this._later('voice-listen', VOICE_LISTEN_AGAIN_MS, () => {
                    if (this._voiceOpen && this._voice.phase === 'reply')
                        this._listen();
                });
            } else {
                const {base, perChar, max} = VOICE_READ_MS;
                this._scheduleVoiceClose(state.actions?.length ? VOICE_DONE_MS
                    : Math.min(max, base + perChar * (state.reply?.length ?? 0)));
            }
        } else if (state.phase === 'error') {
            // Long enough to reach the Sign in button.
            this._scheduleVoiceClose(state.sign_in ? VOICE_READ_MS.max : VOICE_ERROR_MS);
        }
    }

    /** An answer or an error is on show, no longer listening or thinking. */
    get _voiceAnswered() {
        return ['reply', 'error'].includes(this._voice.phase);
    }

    // isled restarted (an update) or stopped while listening or thinking: it will never answer, so
    // the island says so rather than wait forever.
    _onAssistantLost() {
        if (!this._voiceOpen || !['listening', 'transcribing', 'thinking'].includes(this._voice.phase))
            return;
        this._voice.setState({phase: 'error', error: 'Isle restarted', hint: 'Press Super+I to ask again.'});
        this._setKeyboard(false);
        this._render();
        this._scheduleVoiceClose(VOICE_ERROR_MS);
    }

    _scheduleVoiceClose(ms) {
        this._voiceCloseMs = ms;
        // An action may have closed it already.
        if (!this._voiceOpen)
            return;
        if (this._voiceAnswered && !this._island.hovered)
            this._later('voice-close', ms, () => this.collapse());
    }

    /** What the assistant's actions act on; see `ACTIONS` in voice.js. */
    _voiceActions() {
        return {
            daemon: this._daemon,
            audio: this._audio,
            notifications: this._notifications,
            target: this._voiceTarget,
            writer: this._writer,
            // The answer shows for a moment, then the page.
            showNotifications: () => this._later('voice-page', 1200, () => this.expand('notifications')),
            // Closed first, so the island is not in a screenshot or over the lock screen.
            // Every close-first action of an answer runs, in order, once the island has closed.
            closeThen: callback => {
                this._voiceAfter.push(callback);
                this.collapse();
                this._later('voice-after', 450, () => {
                    const callbacks = this._voiceAfter;
                    this._voiceAfter = [];
                    callbacks.forEach(run => run());
                });
            },
        };
    }

    /** Ends the conversation: the AI and the speech model quit until next time. */
    _closeVoice() {
        this._cancel('voice-close');
        this._cancel('voice-listen');
        this._cancel('voice-page');
        this._voiceOpen = false;
        this._voiceTarget = null;
        this._daemon.call('assistant', 'End');
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
        if (this._destroying)
            return;
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
        global.display.get_selection().disconnect(this._primaryChanged);
        global.display.disconnect(this._focusChanged);
        stopPending();
        if (this._voiceBound)
            Main.wm.removeKeybinding('voice-shortcut');
        if (this._voiceOpen)
            this._closeVoice();
        // Releasing the keyboard may schedule a collapse; cancel it after. Tearing down schedules nothing.
        this._setKeyboard(false);
        for (const name of [...this._timeouts.keys()])
            this._cancel(name);
        this._destroying = true;

        const monitor = global.backend.get_core_idle_monitor();
        if (this._idleWatch)
            monitor.remove_watch(this._idleWatch);
        if (this._activeWatch)
            monitor.remove_watch(this._activeWatch);

        this._settingsChanged.forEach(id => this._settings.disconnect(id));
        Main.layoutManager.disconnect(this._monitorsChanged);
        this._osd.destroy();
        this._keyboard.destroy();
        this._shelfHelper.destroy();
        this._reminders.destroy();
        // Ending focus mode can turn Do Not Disturb off, which the views
        // still show.
        this._focusMode.destroy();

        // The views listen to the services below, so they go first.
        this._island.destroy();
        this._writer.destroy();
        this._installedApps.destroy();
        this._clipboard.destroy();
        this._call.destroy();
        this._privacy.destroy();
        this._audio.destroy();
        this._notifications.destroy();
        this._topBar.destroy();
        this._daemon.destroy();
        this._settings = null;
    }
}
