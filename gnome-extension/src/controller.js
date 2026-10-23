// SPDX-License-Identifier: GPL-3.0-or-later

// Decides what the island shows and when (compact, peek or expanded); see docs/product-spec.md.
// Alerts show one at a time; "instant" ones (volume, brightness, critical...) replace what is showing.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import * as Alerts from './alerts.js';
import {paletteFor} from './bot.js';
import {ClipboardHistory} from './clipboard.js';
import {CompactView} from './compact.js';
import {grabsKeyboard} from './compat.js';
import {Daemon} from './daemon.js';
import {BOTTOM_PADDING, ExpandedView, PAGE_HEIGHT} from './expanded.js';
import {Island} from './island.js';
import {AudioOutputs} from './audio.js';
import {CallMonitor} from './call.js';
import {FocusMode} from './focusMode.js';
import * as Format from './format.js';
import {NotificationCenter} from './notifications.js';
import {PrivacyMonitor} from './privacy.js';
import {PeekView} from './peek.js';
import * as Playback from './playback.js';
import {KeyboardWatcher, OsdHook, SF_PRO_CLASS, TopBar, hasSfPro} from './shell.js';
import {ShelfHelper} from './shelfHelper.js';
import {CallPage} from './pages/call.js';
import {CalendarPage} from './pages/calendar.js';
import {MediaPage} from './pages/media.js';
import {NotificationsPage} from './pages/notifications.js';
import {ShelfPage} from './pages/shelf.js';
import {TasksPage} from './pages/tasks.js';
import {TimerPage} from './pages/timer.js';
import {UsagePage} from './pages/usage.js';
import {ReminderWatcher} from './reminders.js';
import {GREETING, InstalledApps, UNDO_MS, VoiceView, actionTypes, aiSettings, openSetUp, openSignIn, runActions, stopPending, voiceContext} from './voice.js';
import {TextWriter} from './writer.js';

/** While the pointer rests before the island opens (Settings: hover-delay), it moves at most this far. */
const REST_DISTANCE_PX = 10;
/** The views and pages are laid out ahead this long after starting, a step at a time (see `_warmUp`). */
const WARM_START_MS = 3000;
const WARM_STEP_MS = 60;
/** What the alert views are laid out with ahead (see `_warmUp`): the parts most alerts have. */
const WARM_ALERT = {key: 'warm', title: 'Charging', subtitle: 'Isle', icon: 'isle-bolt', ring: 0, value: '0%', tone: 'good'};
/** And again this long after the island closes, or a page changes out of sight, while it stays closed... */
const WARM_AFTER_CLOSE_MS = 1500;
/** ...but for changes, at most this often: a notification updating every second (a download) costs little. */
const WARM_GAP_MS = 10000;
/** Outside an island that shrank under it, the pointer is checked this often, and left this long. */
const MOVE_CHECK_MS = 250;
const STILL_OUTSIDE_MS = 30000;
/** Grace period before closing when the pointer leaves. */
const COLLAPSE_DELAY_MS = 300;
/** An alert the pointer rested on stays this long once it leaves, to finish reading. */
const ALERT_LEAVE_MS = 1500;
/** Touchpad travel over an alert that puts it away (up) or opens the island (down); a wheel's click is one. */
const ALERT_SWIPE = 1.5;
/** A pause this long between scroll events starts a new swipe. */
const SWIPE_GAP_MS = 180;
/** A page picked by hand is kept for this long before smart defaults resume. */
const PAGE_MEMORY_MS = 5 * 60 * 1000;
/** An alert's width is checked again this soon after it shows. */
const ALERT_FIT_DELAY_MS = 60;
/** Where updating is explained. */
const UPDATE_HELP = 'https://github.com/zickrian/isle/blob/main/docs/install.md#updating';
/** Which switch in Settings each kind of system event answers to. */
const SYSTEM_ALERTS = {power: 'power', battery_low: 'power', battery_full: 'power', network: 'network', bluetooth: 'bluetooth'};
/** The open island's header on a display without the top bar. */
const HEADER_WITHOUT_BAR = 32;
/** isled may be away this long (restarting after an update) before the island does anything about it. */
const SERVICE_GRACE_MS = 5000;
/** Opened from the keyboard without getting it, the island closes this soon unless the pointer is on it. */
const KEYBOARD_LESS_CLOSE_MS = 4000;
/** Notifications waiting to be shown past this many come as one summary. */
const MAX_QUEUED_NOTIFICATIONS = 3;
/** Without input for this long, the user is away and animations rest; sooner on battery. */
const IDLE_MS = 60 * 1000;
const IDLE_ON_BATTERY_MS = 15 * 1000;

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
/** isled's phases while it works on a request: with the island closed, it carries on in the background. */
/** Where in its flow, and how bright, the still glow of an alert that asks is drawn. */
const ALERT_GLOW_TIME = 2.2;
const ALERT_GLOW_LEVEL = 0.3;
/** The conversation shows this many messages at most. */
const CHAT_SHOWN = 50;
/** In the conversation, the field comes back this soon (ms) after an answer. */
const CHAT_TYPE_AGAIN_MS = 250;
const VOICE_WORKING = ['transcribing', 'thinking', 'acting'];

// Pages that open by default when they have something to show, best first, unless one was picked
// by hand lately. Notifications count only when some arrived unseen (others were shown as alerts).
const DEFAULT_PAGE_ORDER = ['call', 'notifications', 'music', 'focus'];
/** The AI agents Isle can hear from (see `Agents1` in the daemon). */
const AGENT_PROVIDERS = ['claude', 'codex'];

export class Controller {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._daemon = new Daemon();
        // Heard once everything listening is built (see `_connectAll`).
        this._daemon.hold();
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
        /** The touchpad swipe over an alert under way: {dy, at, done} (see `_onAlertScroll`). */
        this._swipe = null;
        /** Whether the alert and voice views were laid out ahead since the theme last changed (see `_warmUp`). */
        this._viewsWarm = false;
        /** Counts `_listen` calls, so only the latest sends its request. */
        this._listenRequest = 0;
        this._voiceCloseMs = VOICE_ERROR_MS;
        /** The last answer whose actions ran, and the last batch of actions run mid-way (see isled's `step`). */
        this._voiceTurn = 0;
        this._voiceStep = 0;
        /** A request carries on after the island closed; its answer comes as an alert. */
        this._voiceInBackground = false;
        /** Times in a row it listened again by itself; see `VOICE_MAX_AUTO_LISTENS`. */
        this._autoListens = 0;
        /** The window in front when the assistant opened, for it to write into. */
        this._voiceTarget = null;
        /** Actions waiting for the island to close; see `closeThen`. */
        this._voiceAfter = [];
        /** The window text was last selected in, so a selection only goes to the AI from where it was made. */
        this._selectedIn = null;

        // Built a part at a time, frames drawn in between: all at once, it held the screen still for a tenth
        // of a second at every login and unlock. Nothing outside calls in before the last part.
        this._pages = [];
        this._buildSteps = [
            () => this._buildServices(),
            () => this._buildViews(),
            // A page a step: the music and shelf pages alone take a frame's time.
            ...this._pageMakers().map(make => () => this._pages.push(make())),
            () => (this._expanded = this._buildExpanded(this._pages)),
            () => this._buildIsland(),
            () => this._connectAll(),
        ];
        this._building = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._buildSteps.shift()();
            if (this._buildSteps.length)
                return GLib.SOURCE_CONTINUE;
            this._building = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _buildServices() {
        // One "system alerts" switch before 0.7: an "off" there carries over to each of its parts.
        if (!this._settings.get_boolean('system-alerts')) {
            for (const category of ['power', 'network', 'bluetooth', 'caps-lock'])
                this._settings.set_boolean(`alert-${category}`, false);
            this._settings.set_boolean('system-alerts', true);
        }
        this._notifications = new NotificationCenter(this._settings);
        this._privacy = new PrivacyMonitor(this._daemon);
        this._call = new CallMonitor(this._privacy, this._settings);
        this._audio = new AudioOutputs();
        this._focusMode = new FocusMode(this._daemon, this._notifications, this._settings);
        this._clipboard = new ClipboardHistory(this._daemon, this._settings);
        this._writer = new TextWriter(this._clipboard);
    }

    _buildViews() {
        this._island = new Island();
        if (hasSfPro())
            this._island.add_style_class_name(SF_PRO_CLASS);
        this._compact = new CompactView(this._daemon, this._settings, this._privacy, this._call);
        // Two, taking turns: a new alert fades in over the one it replaces, rather than swapping in a frame.
        this._peeks = [new PeekView(), new PeekView()];
        this._peek = this._peeks[0];
        this._botLook = this._readBotLook();
        this._voice = new VoiceView(this._botLook);
        this._voice.chatLook = this._botLook;
    }

    // The bar and the island appear together: the clock gives way to it in the same frame.
    _buildIsland() {
        this._topBar = new TopBar(this._settings);
        this._shelf = this._expanded.pageNamed('shelf');
        this._shelfHelper = new ShelfHelper(this._island, this._shelf);
        for (const view of [this._compact, ...this._peeks, this._expanded, this._voice])
            this._island.addView(view);
        Main.layoutManager.addChrome(this._island, {trackFullscreen: true});
        this._updateGeometry();
        this._render();
    }

    _connectAll() {
        this._primaryChanged = global.display.get_selection().connect('owner-changed', (_selection, type) => {
            if (type === Meta.SelectionType.SELECTION_PRIMARY)
                this._selectedIn = global.display.focus_window;
        });
        // Clicking into a window, or one an action opened, puts an answer away.
        this._focusChanged = global.display.connect('notify::focus-window', () => {
            const focus = global.display.focus_window;
            if (this._voiceOpen && this._voiceAnswered && focus && focus !== this._voiceTarget)
                this.collapse();
            this._syncMonitor();
        });
        // Hidden by a fullscreen window meanwhile: what waited shows now.
        this._island.connect('notify::visible', () => {
            if (this._island.visible && !this._alert)
                this._nextAlert();
        });
        this._connectSignals();
        this._keyboard = new KeyboardWatcher();
        this._keyboard.connect('caps-lock', (_watcher, on) => this._postSystemAlert(Alerts.capsLock(on), 'caps-lock'));
        this._osd = new OsdHook((icon, label, level, maxLevel) => this._showOsd(icon, label, level, maxLevel));
        this._watchIdle();
        this._installedApps = new InstalledApps();
        this._reminders = new ReminderWatcher(this._daemon, (reminder, done) => {
            this._post(Alerts.reminder(reminder, () => {
                this._chime('complete');
                done();
            }));
        });
        this._syncVoiceEnabled();
        this._syncUsage();
        this._syncEventAlerts();
        this._render();
        this._later('warm', WARM_START_MS, () => this._warmUp(true));
        this._daemon.release();
    }

    /** Makes each page, in tab order. */
    _pageMakers() {
        const size = {height: PAGE_HEIGHT};
        return [
            () => new CallPage(this._daemon, this._call, this._privacy, this._settings, size),
            () => new MediaPage(this._daemon, this._audio, size),
            () => new NotificationsPage(this._daemon, this._notifications, size),
            () => new TimerPage(this._daemon, size),
            () => new TasksPage(this._daemon, size),
            () => new ShelfPage(this._daemon, this._clipboard, this._settings, size),
            () => new CalendarPage(this._daemon, size),
            () => new UsagePage(this._daemon, size),
        ];
    }

    _buildExpanded(pages) {
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
        expanded.connect('voice-requested', () => this._openVoice({typing: true}));
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
        // A new theme or text size restyles every view: laid out ahead again at the next warm-up.
        island.connect('style-changed', () => (this._viewsWarm = false));
        island.connect('button-release-event', (_actor, event) => this._onClick(event));
        island.connect('scroll-event', (_actor, event) => this._onAlertScroll(event));
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
        this._settingsChanged.push(this._settings.connect('changed::island-monitor', () => this._updateGeometry()));
        // On the display in use, it follows the window in front, once closed.
        this._focusMonitorChanged = global.display.connect('window-entered-monitor', () => this._syncMonitor());
        this._settingsChanged.push(this._settings.connect('changed::voice-assistant', () => this._syncVoiceEnabled()));
        this._settingsChanged.push(this._settings.connect('changed::voice-shortcut', () => (this._voice.shortcut = this._voiceShortcut)));
        for (const key of ['bot-shape', 'bot-color', 'bot-glow'])
            this._settingsChanged.push(this._settings.connect(`changed::${key}`, () => this._syncBotLook()));
        for (const key of ['usage-enabled', 'usage-claude', 'usage-codex', 'usage-warn', 'usage-critical'])
            this._settingsChanged.push(this._settings.connect(`changed::${key}`, () => this._syncUsage()));
        for (const key of ['event-alerts', 'event-alert-minutes'])
            this._settingsChanged.push(this._settings.connect(`changed::${key}`, () => this._syncEventAlerts()));
        for (const provider of AGENT_PROVIDERS) {
            this._settingsChanged.push(this._settings.connect(`changed::agent-alerts-${provider}`, () =>
                this._hookAgent(provider)));
        }

        this._topBar.connect('height-changed', () => this._updateGeometry());
        this._topBar.connect('style-changed', () => this._updateGeometry());
        this._topBar.connect('calendar-requested', () => this._toggleFromKeyboard());
        island.connect('key-press-event', (_actor, event) => {
            // A command waiting on the user: Enter runs it, Esc denies it.
            const key = event.get_key_symbol();
            if (this._voiceOpen && this._voice.cardWaiting && !this._voice.typing &&
                [Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_Escape].includes(key)) {
                this._voice.decideCard(key !== Clutter.KEY_Escape);
                return Clutter.EVENT_STOP;
            }
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.collapse();
                return Clutter.EVENT_STOP;
            }
            // Typing while it listens: the request is typed instead.
            const typed = event.get_key_unicode();
            const modified = event.get_state() & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK |
                Clutter.ModifierType.SUPER_MASK);
            if (this._voiceOpen && !this._voice.typing && this._voice.phase === 'listening' && !modified &&
                typed && /\S/.test(typed)) {
                this._startTyping(typed);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
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
        daemon.connect('running-changed', () => this._onServiceChanged());
        // Never started at all (a broken install) is the same as stopped.
        this._onServiceChanged();
        daemon.connect('usage-alert', (_daemon, provider, window, percent, resetsAt) =>
            this._post(Alerts.usage(provider, window, percent, resetsAt, this._settings.get_int('usage-critical'))));
        // isled forgets the settings when it restarts; they are sent again whenever it appears.
        daemon.connect('appeared', (_daemon, name) => {
            if (name === 'usage')
                this._syncUsage();
            else if (name === 'updates')
                this._syncUpdates();
            else if (name === 'media')
                this._daemon.call('media', 'SetLyrics', this._settings.get_boolean('lyrics-online'));
            else if (name === 'agents')
                this._syncAgents(true);
        });
        daemon.connect('agent-event', (_daemon, event) => this._onAgentEvent(event));
        this._expanded.pageNamed('calendar').connect('event-soon', (_page, json) => this._onEventSoon(JSON.parse(json)));
        daemon.connect('changed', (_daemon, key) => {
            if (key === 'updates')
                this._onLatest();
            else if (key === 'agents' && this._agentsUnsynced)
                this._syncAgents();
        });
        this._settingsChanged.push(this._settings.connect('changed::check-updates', () => this._syncUpdates()));
        this._settingsChanged.push(this._settings.connect('changed::lyrics-online', () =>
            this._daemon.call('media', 'SetLyrics', this._settings.get_boolean('lyrics-online'))));
        this._voice.connect('orb-clicked', () => this._onVoiceKey());
        this._voice.connect('type-requested', () => this._startTyping(''));
        this._voice.connect('typed', (_view, text) => this._ask(text));
        // Typing, then speaking after all: the field goes, it listens (the conversation stays open).
        this._voice.connect('speak', () => {
            this._autoListens = 0;
            this._listen();
        });
        this._voice.connect('new-chat', () => this._newChat());
        this._voice.connect('undo-new-chat', () => this._undoNewChat());
        this._voice.connect('stop', () => {
            this._daemon.call('assistant', 'Cancel');
            this.collapse();
            // Stopped, not left to carry on.
            this._voiceInBackground = false;
            this._syncAssistantBusy();
        });
        // An AI's CLI signs in from a terminal; the island gets out of its way.
        this._voice.connect('sign-in', () => {
            if (openSignIn(this._daemon.state.assistant?.provider))
                this.collapse();
        });
        this._voice.connect('set-up', () => {
            if (openSetUp(this._daemon.state.assistant?.model))
                this.collapse();
        });
        this._voice.connect('frame', (_view, time, level) => this._island.setTintMotion(time, level));
        this._voice.connect('size-changed', () => {
            if (this._presentation === 'voice')
                this._render();
        });
        daemon.connect('pomodoro-finished', (_daemon, finished, next) => {
            this._chime('complete');
            this._post(Alerts.pomodoroFinished(finished, next, daemon.state.pomodoro, daemon));
        });
        daemon.connect('system-event', (_daemon, event) =>
            this._postSystemAlert(Alerts.system(event), SYSTEM_ALERTS[event.kind] ?? 'power', event.kind === 'battery_low'));

        // Sharing or recording the screen, what others write and what was copied stay out of sight.
        this._privacy.connect('changed', () => this._syncSharing());
        this._syncSharing();
        this._privacy.connect('recording-started', () =>
            this._post(Alerts.recordingStarted(() => this._privacy.stopRecording())));
        // A new call is what the island opens on next, whatever was picked before.
        this._call.connect('started', () => (this._pagePickedAt = 0));

        // GNOME's notifications appear in the island instead of as banners.
        const notifications = this._notifications;
        notifications.connect('banner', (_center, notification) => {
            const urgent = notification.urgency === MessageTray.Urgency.CRITICAL;
            this._post(Alerts.notification(notification, urgent, () => notifications.acknowledge(notification),
                this._sharing));
        });
        notifications.connect('dnd-changed', () => (this._compact.doNotDisturb = notifications.dnd));
        notifications.connect('changed', () => (this._compact.unseenNotifications = notifications.unseenCount > 0));
        notifications.connect('seen-changed', () => (this._compact.unseenNotifications = notifications.unseenCount > 0));
        this._compact.doNotDisturb = notifications.dnd;
        this._compact.unseenNotifications = notifications.unseenCount > 0;
    }

    // Layout

    _updateGeometry() {
        this._monitor = this._wantedMonitor();
        // On a black bar the island grows out of it, its shoulders below the
        // bar; on any other it hangs from the top of the screen like a notch.
        this._island.topInset = this._blendsIn ? this._topBar.height : 0;
        this._island.monitor = this._monitor;
        // Without a top bar (another display) the open island's header is its own.
        this._expanded.topInset = this._onBar ? this._topBar.height : HEADER_WITHOUT_BAR;
        this._topBar.clockShown = !this._onBar;
        this._render();
    }

    /** The display the island belongs on: the main one, or the one of the window in use (see Settings). */
    _wantedMonitor() {
        const {monitors, primaryMonitor} = Main.layoutManager;
        if (this._settings.get_string('island-monitor') !== 'active')
            return primaryMonitor;
        const index = global.display.focus_window?.get_monitor() ?? -1;
        return monitors[index] ?? primaryMonitor;
    }

    /** Moves the island to the display in use, once it is closed (never mid-alert or open). */
    _syncMonitor() {
        if (this._monitor && this._presentation === 'compact' && this._wantedMonitor() !== this._monitor)
            this._updateGeometry();
    }

    /** Whether the island is on the main display, in its top bar. */
    get _onBar() {
        return this._monitor === Main.layoutManager.primaryMonitor;
    }

    /** Whether it grows out of a black top bar there. */
    get _blendsIn() {
        return this._onBar && this._topBar.blendsIn;
    }

    // Calendar and AI agents

    /** The calendar alarms, as Settings say (see `CalendarPage.alarmLead`). */
    _syncEventAlerts() {
        const minutes = this._settings.get_boolean('event-alerts') ? this._settings.get_int('event-alert-minutes') : 0;
        this._expanded.pageNamed('calendar').alarmLead = minutes;
    }

    /** An event starts soon: an alert, with Join when the event has a meeting link. Not in Do Not Disturb. */
    async _onEventSoon(event) {
        if (this._notifications.dnd)
            return;
        let link = '';
        // GNOME's id: the calendar, the event and its recurrence, a line each.
        const [source, uid] = event.id?.split('\n') ?? [];
        if (source && uid)
            link = (await this._daemon.call('calendar', 'MeetingLink', source, uid))?.[0] ?? '';
        // Isle turned off, or Do Not Disturb on, while the link was looked for.
        if (this._destroying || this._notifications.dnd)
            return;
        this._post(Alerts.meeting(event, link, () => {
            try {
                Gio.AppInfo.launch_default_for_uri(link, global.create_app_launch_context(0, -1));
            } catch (e) {
                console.warn(`Isle: could not open the meeting: ${e.message}`);
            }
        }));
    }

    /** The hooks as Settings say, once isled is there: a switch left on comes back after a reinstall, and one
     * turned off while isled was away takes its hook out. */
    _syncAgents(appeared = false) {
        // Started again, isled's properties may come a moment after it: then on the first of them.
        this._agentsUnsynced = !this._daemon.state.agents && (appeared || this._agentsUnsynced);
        if (this._agentsUnsynced)
            return;
        const agents = this._daemon.state.agents;
        for (const provider of AGENT_PROVIDERS) {
            const {found, hooked} = agents[provider] ?? {};
            // Not found any more, a hook left behind still goes when its switch is off.
            if ((found || hooked) && Boolean(hooked) !== this._settings.get_boolean(`agent-alerts-${provider}`))
                this._hookAgent(provider);
        }
    }

    /** Puts in or takes out `provider`'s hook, as its switch says; refused, the switch goes off and says why. */
    async _hookAgent(provider) {
        const on = this._settings.get_boolean(`agent-alerts-${provider}`);
        const {error} = await this._daemon.attempt('agents', 'SetHooked', provider, on);
        if (!error || !on || this._destroying)
            return;
        this._settings.set_boolean(`agent-alerts-${provider}`, false);
        this._post(Alerts.agentRefused(provider, error));
    }

    /** Claude Code or Codex needs the user, or is done: an alert, unless its window is the one in front. */
    _onAgentEvent(event) {
        if (!this._settings.get_boolean(`agent-alerts-${event.provider}`) || this._notifications.dnd)
            return;
        const window = this._agentWindow(event.project);
        if (window && window === global.display.focus_window)
            return;
        this._post(Alerts.agent(event, window ? () => Main.activateWindow(window) : null));
    }

    /** The window (a terminal, VS Code) whose title names `project`, the latest used first. */
    _agentWindow(project) {
        if (!project)
            return null;
        return global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(window => (window.get_title() ?? '').includes(project))
            .sort((a, b) => b.get_user_time() - a.get_user_time())[0] ?? null;
    }

    _render() {
        if (this._destroying)
            return;
        const presentation = this._voiceOpen ? 'voice'
            : this._expandWanted ? 'expanded' : this._alert ? 'peek' : 'compact';
        this._presentation = presentation;
        if (presentation !== 'compact')
            this._putAwayWarm();
        // A display without the top bar: the island hangs from its top edge.
        const top = this._onBar ? this._topBar.height : 0;
        const inBar = this._onBar && this._settings.get_boolean('island-in-top-bar');
        // Before measuring it: inside the bar it is smaller.
        this._compact.inBar = inBar;

        // Alerts hang below the top bar; the open island's header sits in the bar. The compact island
        // either hangs too or sits inside the bar like a MacBook's notch, covering no window.
        let size, view;
        switch (presentation) {
        case 'expanded':
            size = {
                width: this._expanded.preferredWidth,
                height: (this._onBar ? top : HEADER_WITHOUT_BAR) + PAGE_HEIGHT + BOTTOM_PADDING,
                radius: EXPANDED_RADIUS,
                shoulder: EXPANDED_SHOULDER,
            };
            view = this._expanded;
            break;
        case 'voice': {
            // Like an alert, it hangs below the bar (or near the top of the screen).
            const inset = this._blendsIn ? top : PEEK_TOP_GLASS;
            size = {width: this._voice.preferredWidth, height: inset + this._voice.fit(), radius: VOICE_RADIUS, shoulder: PEEK_SHOULDER};
            view = this._voice;
            view.style = `padding-top: ${inset}px;`;
            break;
        }
        case 'peek': {
            const inset = this._blendsIn ? top : PEEK_TOP_GLASS;
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
        if (this._onBar)
            this._topBar.reserveWidth(this._compact.preferredWidth);
        this._island.morph(size, view);
        this._expanded.setActive(presentation === 'expanded');
        this._voice.setActive(presentation === 'voice');
        this._syncTint();
        // Closed again, it goes to the display in use if that changed meanwhile.
        if (presentation === 'compact' && this._monitor && this._wantedMonitor() !== this._monitor)
            this._later('monitor', 0, () => this._syncMonitor());
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
        // The voice view only while the assistant is turned on.
        const steps = [];
        if (all) {
            // Each alert view shown with a ring alert's parts until the next step: a frame lays them out.
            for (const peek of this._peeks) {
                steps.push(() => island.warmView(peek, true) && peek.setAlert(WARM_ALERT, null, {fresh: true}));
                steps.push(() => island.warmView(peek, false));
            }
            if (this._voiceBound)
                steps.push(() => island.warmView(this._voice, true) && island.warmView(this._voice, false));
        }
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
            if (steps.length) {
                this._later('warm', WARM_STEP_MS, next);
                return;
            }
            this._warmedAt = GLib.get_monotonic_time() / 1000;
            if (all)
                this._viewsWarm = true;
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
        if (this._presentation !== 'compact' || !this._island.mapped || this._timeouts.has('warm') ||
            !this._expanded.pages.some(page => page.cold))
            return;
        const sinceLast = GLib.get_monotonic_time() / 1000 - (this._warmedAt ?? -Infinity);
        this._later('warm', Math.max(WARM_AFTER_CLOSE_MS, WARM_GAP_MS - sinceLast), () => this._warmUp(false));
    }

    /** The assistant's shape and colours, from Settings (see bot.js). */
    _readBotLook() {
        return {shape: this._settings.get_string('bot-shape'),
            palette: paletteFor(this._settings.get_string('bot-color'), this._settings.get_string('bot-glow'))};
    }

    _syncBotLook() {
        this._botLook = this._readBotLook();
        this._voice.look = this._botLook;
        this._voice.chatLook = this._botLook;
        this._syncTint();
    }

    _syncTint() {
        const expanded = this._presentation === 'expanded';
        const voice = this._presentation === 'voice';
        // An alert that asks or tells what an agent did glows in its colours, still: drawn once.
        const glow = this._presentation === 'peek' ? this._alert?.glow : null;
        const tint = voice ? this._botLook.palette.glow : glow ?? (expanded ? this._expanded.tint : null);
        const style = voice || glow ? 'siri' : expanded ? this._expanded.tintStyle : null;
        if (glow && tint !== this._tint)
            this._island.setTintMotion(ALERT_GLOW_TIME, ALERT_GLOW_LEVEL);
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
        // An alert waits while the pointer is on it, as a notification does on macOS; not the volume's.
        if (this._alert && !this._alert.transient && this._presentation === 'peek') {
            if (this._island.hovered)
                this._cancel('alert');
            else
                this._later('alert', Math.min(ALERT_LEAVE_MS, this._alert.duration ?? ALERT_LEAVE_MS),
                    () => this._dismissAlert(true));
        }
        if (this._island.hovered) {
            this._cancel('collapse');
            if (!this._expandWanted && this._settings.get_string('open-on') === 'hover' && !this._alertHasButtons)
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

    /** An alert with buttons (Join, Allow…) is on show: the pointer goes there to press one, not to open the island. */
    get _alertHasButtons() {
        return this._presentation === 'peek' && Boolean(this._alert?.action || this._alert?.actions?.length);
    }

    // Opens once the pointer rests on the island, so passing over it along the top bar opens nothing.
    _expandOnRest() {
        const [x, y] = global.get_pointer();
        this._later('expand', this._settings.get_int('hover-delay'), () => {
            if (this._alertHasButtons)
                return;
            const [nowX, nowY] = global.get_pointer();
            // The assistant still at work: its progress, rather than the pages (as a click does).
            if (Math.hypot(nowX - x, nowY - y) <= REST_DISTANCE_PX && this._voiceWorking)
                this._reopenVoice();
            else if (Math.hypot(nowX - x, nowY - y) <= REST_DISTANCE_PX)
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

    /** What a click on the closed island does: an alert's own action, or else the island opens. */
    _openFromClosed() {
        // Clicking a notification opens it, like GNOME's banner did.
        if (!this._expandWanted && this._alert?.onActivate) {
            this._alert.onActivate();
            this._dismissAlert(true);
            return Clutter.EVENT_STOP;
        }
        // isled down: why the island can do little, and how to fix it, rather than the pages.
        if (!this._expandWanted && this._compact.serviceDown) {
            this._post(Alerts.serviceDown(() => this._daemon.start()));
            return Clutter.EVENT_STOP;
        }
        // The assistant still at work: its progress, rather than the pages.
        if (!this._expandWanted && this._voiceWorking) {
            this._reopenVoice();
            return Clutter.EVENT_STOP;
        }
        if (!this._expandWanted) {
            this.expand();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /** Over an alert, a swipe up puts it away and a swipe down opens it, as on a phone. */
    _onAlertScroll(event) {
        if (this._presentation !== 'peek' || !this._alert || this._expandWanted)
            return Clutter.EVENT_PROPAGATE;
        let step;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            step = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
            step = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const now = GLib.get_monotonic_time() / 1000;
            if (now - (this._swipe?.at ?? 0) > SWIPE_GAP_MS)
                this._swipe = {dy: 0, done: false};
            this._swipe.at = now;
            this._swipe.dy += event.get_scroll_delta()[1];
            if (this._swipe.done || Math.abs(this._swipe.dy) < ALERT_SWIPE)
                return Clutter.EVENT_STOP;
            // Once a swipe, however far it goes.
            this._swipe.done = true;
            step = Math.sign(this._swipe.dy);
            break;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        // The click-style copies of a smooth scroll count once, as the smooth one.
        if (event.get_flags() & Clutter.EventFlags.POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        // Content scrolls down with fingers moving up (and a wheel turned down): the alert goes up and away.
        if (step > 0)
            this._dismissAlert(true);
        else
            this._openFromClosed();
        return Clutter.EVENT_STOP;
    }

    _onClick(event) {
        // A click puts an answer away; the face and the Sign in button take their own clicks.
        if (this._voiceOpen) {
            if (!this._voiceAnswered || this._voice.chatOpen)
                return Clutter.EVENT_PROPAGATE;
            this.collapse();
            return Clutter.EVENT_STOP;
        }
        switch (event.get_button()) {
        case Clutter.BUTTON_PRIMARY:
            return this._openFromClosed();
        case Clutter.BUTTON_MIDDLE:
            this._daemon.call('media', 'PlayPause');
            return Clutter.EVENT_STOP;
        case Clutter.BUTTON_SECONDARY:
            // On an alert: puts it away without opening what it is about.
            if (!this._expandWanted && this._alert) {
                this._dismissAlert(true);
                return Clutter.EVENT_STOP;
            }
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
        // An action finishing after Isle was turned off.
        if (this._destroying)
            return;
        // A close still pending (the pointer just left) would shut it again.
        this._cancel('expand');
        this._cancel('collapse');
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
        if (this._destroying)
            return;
        this._cancel('collapse');
        this._setKeyboard(false);
        // Once closed and settled, what changed meanwhile is laid out for next time (see `_warmUp`); the
        // alert and voice views keep their layout, unless the theme changed.
        this._later('warm', WARM_AFTER_CLOSE_MS, () => this._warmUp(!this._viewsWarm));
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
        // Hidden by a fullscreen window, it would take the keyboard unseen.
        if (!this._island.visible)
            return;
        if (this._expandWanted && this._keyboardGrab) {
            this.collapse();
            return;
        }
        this._shelf.showTab('clipboard');
        this.expand('shelf');
        this._setKeyboard(true);
        if (this._keyboardGrab)
            this._shelf.showTab('clipboard', {focusSearch: true});
        else // another grab holds the keyboard: it closes once the pointer is not on it
            this._later('collapse', KEYBOARD_LESS_CLOSE_MS, () => {
                if (!this._island.hovered)
                    this._collapseUnlessHeld();
            });
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
        // Hidden by a fullscreen window: shown once it is gone, but a volume or Caps Lock change is stale by then.
        if (!this._island.visible) {
            if (!alert.transient)
                this._enqueue(alert);
            return;
        }
        if (this._alert && this._alert.key === alert.key) {
            this._showAlert(alert, {inPlace: true});
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
        // Shown again afterwards, unless it was a passing one (the volume); a critical notification stays.
        if (this._alert && !this._alert.transient)
            this._queue.unshift(this._alert);
        this._showAlert(alert);
    }

    /** A system alert of `category` (power, network, bluetooth, caps-lock), if wanted; only a low battery gets
     * through Do Not Disturb. */
    _postSystemAlert(alert, category, urgent = false) {
        if (!alert || !this._settings.get_boolean(`alert-${category}`))
            return;
        if (this._notifications.dnd && !urgent)
            return;
        this._post(alert);
    }

    _enqueue(alert) {
        this._queue = this._queue.filter(queued => queued.key !== alert.key);
        this._queue.push(alert);
        // Many notifications waiting (a long fullscreen video) come as one; each stays unread in the list.
        const waiting = this._queue.filter(queued => queued.kind === 'notification' && queued.priority !== 'instant');
        const summary = this._queue.find(queued => queued.key === 'notifications-summary');
        if (waiting.length > (summary ? 0 : MAX_QUEUED_NOTIFICATIONS)) {
            // Counted once each, however often one was updated meanwhile.
            const items = new Set([...summary?.items ?? [], ...waiting.map(queued => queued.item)]);
            this._queue = this._queue.filter(queued => !waiting.includes(queued) && queued !== summary);
            this._queue.push(Alerts.notificationsSummary(items));
        }
    }

    /** `inPlace` for a newer version of the alert on screen (the volume moving): it doesn't animate in again. */
    _showAlert(alert, {inPlace = false} = {}) {
        // Another alert on screen takes the other view; the same one (the volume moving) updates in place.
        if (this._presentation === 'peek' && this._shownAlertKey !== alert.key)
            this._peek = this._peeks[1 - this._peeks.indexOf(this._peek)];
        this._shownAlertKey = alert.key;
        this._alert = alert;
        if (!alert.shown) {
            alert.shown = true;
            alert.onShown?.();
        }
        // Its button does what it says, and that is the end of the alert (not of one fading in over it).
        this._peek.setAlert(alert, () => {
            if (this._alert === alert)
                this._dismissAlert(true);
        }, {fresh: !inPlace});
        this._timeAlert();
        this._render();
        // Parts shown for the first time are only measured right once styled;
        // fit the island again then.
        this._later('alert-fit', ALERT_FIT_DELAY_MS, () => {
            if (this._presentation === 'peek')
                this._render();
        });
    }

    // An alert goes after its time; a sticky one (a reminder) only counts it while someone is there.
    _timeAlert() {
        const alert = this._alert;
        if (!alert)
            return;
        // Not while someone reads it (see `_onHoverChanged`), nor while no one is there for a sticky one.
        if ((this._island.hovered && !alert.transient) || (alert.sticky && this._compact.idle)) {
            this._cancel('alert');
            return;
        }
        this._later('alert', alert.duration ?? 3000, () => this._dismissAlert(true));
    }

    _dismissAlert(showNext) {
        this._cancel('alert');
        this._alert = null;
        if (showNext)
            this._nextAlert();
    }

    _nextAlert() {
        if (!this._island.visible || this._expandWanted || this._voiceOpen || !this._queue.length) {
            this._render();
            return;
        }
        // What waited may have been read, withdrawn or become private meanwhile.
        while (this._queue.length) {
            const queued = this._queue.shift();
            const alert = queued.fresh ? queued.fresh(this._sharing) : queued;
            if (alert) {
                this._showAlert(alert);
                return;
            }
        }
        this._render();
    }

    _showOsd(icon, label, level, maxLevel) {
        if (!this._settings.get_boolean('replace-osd') || !this._island.visible)
            return false;
        // Working on another display, the user would not see it: GNOME shows its own there.
        if (Main.layoutManager.monitors.length > 1 && global.display.get_current_monitor() !== this._monitor?.index)
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

    // isled gone (a crash, or stopped by hand): started again once; still gone, the island says so and offers
    // to restart it, with a warning on the closed island meanwhile.
    _onServiceChanged() {
        if (this._daemon.running) {
            this._cancel('service-check');
            this._compact.serviceDown = false;
            if (this._alert?.key === 'service-down')
                this._dismissAlert(true);
            this._queue = this._queue.filter(queued => queued.key !== 'service-down');
            return;
        }
        this._later('service-check', SERVICE_GRACE_MS, () => {
            this._daemon.start();
            this._later('service-check', SERVICE_GRACE_MS, () => {
                if (this._daemon.running)
                    return;
                this._compact.serviceDown = true;
                this._post(Alerts.serviceDown(() => this._daemon.start()));
            });
        });
    }

    /** Whether others may see the screen now: shared, or recorded. */
    get _sharing() {
        return this._privacy.screenShare || this._privacy.recording;
    }

    _syncSharing() {
        this._shelf.sharing = this._sharing;
        this._expanded.pageNamed('notifications').sharing = this._sharing;
        // A message on screen as sharing starts loses its text at once.
        const redone = this._alert?.fresh?.(this._sharing);
        if (redone && redone !== this._alert)
            this._showAlert(redone, {inPlace: true});
    }

    // Updates

    _syncUpdates() {
        this._daemon.call('updates', 'SetEnabled', this._settings.get_boolean('check-updates'));
    }

    /** A newer Isle is out: said once per version. */
    _onLatest() {
        const latest = this._daemon.state.updates;
        if (!latest || latest === this._settings.get_string('update-shown'))
            return;
        this._settings.set_string('update-shown', latest);
        this._post(Alerts.update(latest, () => Gio.AppInfo.launch_default_for_uri(UPDATE_HELP,
            global.create_app_launch_context(0, -1))));
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
        if (enabled)
            this._viewsWarm = false;
        this._expanded.voiceEnabled = enabled;
        this._voice.shortcut = this._voiceShortcut;
    }

    // The shortcut (or the face) opens the assistant listening; while listening it finishes,
    // and once answered it listens again for a follow-up.
    _onVoiceKey() {
        // Hidden by a fullscreen window: it would listen unseen.
        if (!this._island.visible)
            return;
        if (!this._voiceOpen) {
            // A request still at work shows its progress; a new one waits until it is done.
            if (this._voiceWorking)
                this._reopenVoice();
            else
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

    // Opened by Super+I it listens; with `typing` (opened with the mouse) the field is ready instead, and an
    // ongoing conversation shows above it.
    _openVoice({typing = false} = {}) {
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
        this._voiceInBackground = false;
        this._voiceTurn = this._daemon.state.assistant?.turn ?? 0;
        this._voiceStep = this._daemon.state.assistant?.step ?? 0;
        this._autoListens = 0;
        if (!typing) {
            this._listen({greet: true});
            return;
        }
        this._startTyping('');
        if (this._chatItems?.length && !this._chatStale(Date.now())) {
            this._voice.setHistory([...this._chatItems]);
            this._voice.openChat();
        }
    }

    /** Types the request instead of saying it: listening stops (speech recognition never starts). */
    _startTyping(initial) {
        if (this._daemon.state.assistant?.phase === 'listening')
            this._daemon.call('assistant', 'Cancel');
        this._listenRequest++;
        this._cancel('voice-close');
        this._cancel('voice-listen');
        this._setKeyboard(true);
        this._voice.followUp = null;
        this._voice.greeting = null;
        this._voice.startTyping(initial);
        this._render();
    }

    /** Asks a typed request, with what the island knows, as `_listen` does for a spoken one. */
    async _ask(text) {
        this._askedTyped = true;
        // In the conversation, what was sent shows at once, as in Messages.
        if (this._voice.chatOpen) {
            this._sent = {role: 'user', text, spoken: false, at: Date.now()};
            this._chatItems.push(this._sent);
            this._voice.setHistory([...this._chatItems]);
        }
        const request = ++this._listenRequest;
        this._voice.setState({phase: 'thinking', heard: text});
        this._render();
        let json;
        try {
            json = await voiceContext(this._settings, this._notifications,
                {apps: this._installedApps.names, selectedIn: this._selectedIn});
        } catch (e) {
            console.warn(`Isle: could not gather the request's context: ${e.message}`);
            json = JSON.stringify({...aiSettings(this._settings), actions: actionTypes()});
        }
        if (this._voiceOpen && request === this._listenRequest)
            this._daemon.call('assistant', 'Ask', text, json);
    }

    /** Shows the assistant again as it is (at work, or with the answer it came to), without listening. */
    _reopenVoice() {
        const state = this._daemon.state.assistant;
        if (!this._voiceBound || !state)
            return;
        this._cancel('expand');
        this._cancel('collapse');
        this._expandWanted = false;
        this._voiceOpen = true;
        this._voiceInBackground = false;
        this._voiceTarget = global.display.focus_window;
        this._voice.followUp = null;
        this._voice.greeting = null;
        this._voice.setState(state);
        this._syncAssistantBusy();
        this._render();
        if (this._voiceAnswered)
            this._scheduleVoiceClose(VOICE_READ_MS.max);
    }

    /** The assistant's shortcut as people write it, or '' when it has none. */
    get _voiceShortcut() {
        return Format.shortcutLabel(this._settings.get_strv('voice-shortcut')[0] ?? '');
    }

    get _askAgainHint() {
        return this._voiceShortcut ? `Press ${this._voiceShortcut} to ask again.` : 'Ask again from the mic in the island.';
    }

    /** Whether the assistant works on a request with the island closed. */
    get _voiceWorking() {
        return this._voiceInBackground && VOICE_WORKING.includes(this._daemon.state.assistant?.phase);
    }

    /** The closed island shows the assistant at work. */
    _syncAssistantBusy() {
        this._compact.assistantBusy = this._voiceWorking;
    }

    async _listen({greet = false} = {}) {
        this._askedTyped = false;
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
        if (!state)
            return;
        const ours = this._voiceOpen || this._voiceInBackground;
        // Actions it takes mid-way, open or closed: each batch once, and what they did goes back.
        if (ours && state.phase === 'acting' && state.step !== this._voiceStep) {
            this._voiceStep = state.step;
            const step = state.step;
            runActions(state.actions, this._voiceActions()).then(results =>
                this._daemon.call('assistant', 'Results', step, JSON.stringify(results)));
        }
        this._syncAssistantBusy();
        if (!this._voiceOpen) {
            this._onAssistantInBackground(state);
            return;
        }
        if (state.phase === 'idle')
            return;
        // Typing: the listening it stopped may still report in.
        if (this._voice.typing && ['listening', 'transcribing'].includes(state.phase))
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
            this._noteExchange(state);
            runActions(state.actions, this._voiceActions());
            // In the conversation the answer is already in the list: the field is ready for the next word.
            if (this._voice.chatOpen && !state.listen) {
                this._later('chat-type', CHAT_TYPE_AGAIN_MS, () => this._voice.chatOpen && this._startTyping(''));
            } else if (state.listen && this._autoListens < VOICE_MAX_AUTO_LISTENS) {
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
            this._scheduleVoiceClose(state.sign_in || state.set_up ? VOICE_READ_MS.max : VOICE_ERROR_MS);
        }
    }

    // Answered with the island closed: its actions run, and the answer (or what went wrong) shows as an
    // alert, which opens it in full.
    _onAssistantInBackground(state) {
        if (!this._voiceInBackground)
            return;
        if (state.phase === 'reply' && state.turn !== this._voiceTurn) {
            this._voiceTurn = state.turn;
            this._noteExchange(state);
            runActions(state.actions, this._voiceActions());
        } else if (state.phase !== 'error') {
            return;
        }
        this._voiceInBackground = false;
        this._syncAssistantBusy();
        this._post(Alerts.assistant(state, () => this._reopenVoice()));
    }

    // The conversation so far, kept here until isled keeps it (see docs/product-spec.md): what was said
    // and answered, started over after the time set in Settings without a word.
    _noteExchange(state) {
        const now = Date.now();
        if (this._chatStale(now))
            this._chatItems = [];
        this._chatAt = now;
        // Shown already when sent from the conversation.
        const sent = this._sent && this._chatItems.includes(this._sent) && this._sent.text === state.heard;
        this._sent = null;
        if (state.heard && !sent)
            this._chatItems.push({role: 'user', text: state.heard, spoken: !this._askedTyped, at: now});
        // The command it ran (or was told not to) goes in as one line; in the conversation the card makes way.
        const card = this._voice.endedCard;
        if (card)
            this._chatItems.push({role: 'command', command: card.command, status: card.status, at: now});
        if (state.reply)
            this._chatItems.push({role: 'assistant', text: state.reply, at: now});
        if (card && this._voice.chatOpen)
            this._voice.showCard(null);
        this._chatItems = this._chatItems.slice(-CHAT_SHOWN);
        this._voice.setHistory([...this._chatItems]);
    }

    /** Shows the command card (see CommandCard); one waiting takes the keys, for Enter and Esc. */
    _showCard(card) {
        this._voice.showCard(card);
        if (card?.status === 'waiting' && this._voiceOpen)
            this._setKeyboard(true);
    }

    /** Whether the conversation has gone quiet longer than Settings keep it. */
    _chatStale(now) {
        const keep = {'idle-30m': 30, 'idle-2h': 120}[this._settings.get_string('voice-keep-chat')];
        return keep ? now - (this._chatAt ?? 0) > keep * 60000
            : new Date(this._chatAt ?? 0).toDateString() !== new Date(now).toDateString();
    }

    // +: the conversation goes, though Undo brings it back for a moment.
    _newChat() {
        this._chatUndo = this._chatItems ?? [];
        this._chatItems = [];
        this._voice.setHistory([]);
        this._voice.showUndo(true);
        this._later('chat-undo', UNDO_MS, () => {
            this._chatUndo = null;
            this._voice.showUndo(false);
        });
    }

    _undoNewChat() {
        this._cancel('chat-undo');
        this._chatItems = this._chatUndo ?? [];
        this._chatUndo = null;
        this._voice.setHistory([...this._chatItems]);
        this._voice.openChat();
    }

    /** An answer or an error is on show, no longer listening or thinking. */
    get _voiceAnswered() {
        return ['reply', 'error'].includes(this._voice.phase);
    }

    // isled restarted (an update) or stopped while listening or thinking: it will never answer, so
    // the island says so rather than wait forever.
    _onAssistantLost() {
        if (this._voiceInBackground) {
            this._voiceInBackground = false;
            this._syncAssistantBusy();
            this._post(Alerts.assistant({phase: 'error', error: 'Isle restarted', hint: this._askAgainHint},
                () => this._openVoice()));
            return;
        }
        if (!this._voiceOpen || !['listening', ...VOICE_WORKING].includes(this._voice.phase))
            return;
        this._voice.setState({phase: 'error', error: 'Isle restarted', hint: this._askAgainHint});
        this._setKeyboard(false);
        this._render();
        this._scheduleVoiceClose(VOICE_ERROR_MS);
    }

    _scheduleVoiceClose(ms) {
        this._voiceCloseMs = ms;
        // An action may have closed it already; an open conversation stays until put away.
        if (!this._voiceOpen || this._voice.chatOpen)
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
        // Still at work: it carries on, and its answer comes as an alert.
        this._voiceInBackground = VOICE_WORKING.includes(this._daemon.state.assistant?.phase);
        this._syncAssistantBusy();
        this._daemon.call('assistant', 'End');
    }

    _chime(soundName) {
        if (this._settings.get_boolean('chimes'))
            global.display.get_sound_player().play_from_theme(soundName, 'Isle', null);
    }

    // Idle

    _watchIdle() {
        const monitor = global.backend.get_core_idle_monitor();
        const rest = () => {
            this._compact.idle = true;
            // Away: a reminder on screen waits for them.
            if (this._alert?.sticky)
                this._cancel('alert');
            if (!this._activeWatch) {
                this._activeWatch = monitor.add_user_active_watch(() => {
                    this._activeWatch = 0;
                    this._compact.idle = false;
                    // Back: a reminder that waited starts its time now.
                    this._timeAlert();
                });
            }
        };
        this._idleWatch = monitor.add_idle_watch(IDLE_MS, rest);
        this._batteryIdleWatch = monitor.add_idle_watch(IDLE_ON_BATTERY_MS, () => {
            const battery = this._daemon.state.system?.battery;
            if (battery && !battery.plugged)
                rest();
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
        // Turned off while still being built (locked at once): only what was built goes.
        if (this._building) {
            GLib.source_remove(this._building);
            this._building = 0;
            this._destroyPartial();
            return;
        }
        global.display.get_selection().disconnect(this._primaryChanged);
        global.display.disconnect(this._focusChanged);
        global.display.disconnect(this._focusMonitorChanged);
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
        if (this._batteryIdleWatch)
            monitor.remove_watch(this._batteryIdleWatch);
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

    /** Frees what the steps of building (see the constructor) made before it was turned off: nothing
     * outside knows of it yet, but for what it built. */
    _destroyPartial() {
        this._destroying = true;
        for (const name of [...this._timeouts.keys()])
            this._cancel(name);
        this._shelfHelper?.destroy();
        // The views are the island's once it is on screen (see `_buildIsland`); before, each goes by itself.
        if (!this._island?.get_parent()) {
            for (const view of [this._compact, ...this._peeks ?? [], this._voice, this._expanded])
                view?.destroy();
            if (!this._expanded)
                this._pages.forEach(page => page.destroy());
        }
        this._island?.destroy();
        for (const service of [this._topBar, this._writer, this._clipboard, this._focusMode, this._call,
            this._privacy, this._audio, this._notifications, this._daemon])
            service?.destroy();
        this._settings = null;
    }
}
