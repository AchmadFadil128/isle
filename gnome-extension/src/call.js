// SPDX-License-Identifier: GPL-3.0-or-later

// A call in any app (WhatsApp, Telegram, Meet in a browser…): an app holding the microphone,
// the window it runs in, and the microphone's mute. Event driven, like privacy.js.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import {LEVEL_METERS} from './privacy.js';

/** The microphone must be held this long to count: sites open it briefly to ask for permission. */
const START_DELAY_MS = 2000;
/** A tab named after a call service only names the call this early on (µs), while it is the call's tab. */
const SERVICE_GRACE_US = 15 * 1000 * 1000;
/** A call outlasts the microphone closing this long, as apps reopen it to switch devices. */
const END_DELAY_MS = 4000;
/** Apps that record rather than call, matched in their names. */
const RECORDERS = ['obs', 'audacity', 'tenacity', 'recorder', 'kooha', 'kdenlive', 'ardour'];
/** The icon Gvc gives a stream that names none. */
const DEFAULT_STREAM_ICON = 'audio-input-microphone';

/** Call services named in window titles, for calls in a browser. */
const SERVICES = [
    [/google meet|\bmeet\b/i, 'Google Meet'],
    [/whatsapp/i, 'WhatsApp'],
    [/telegram/i, 'Telegram'],
    [/discord/i, 'Discord'],
    [/zoom/i, 'Zoom'],
    [/microsoft teams|\bteams\b/i, 'Microsoft Teams'],
    [/jitsi/i, 'Jitsi Meet'],
    [/slack/i, 'Slack'],
    [/messenger/i, 'Messenger'],
    [/signal/i, 'Signal'],
    [/skype/i, 'Skype'],
    [/webex/i, 'Webex'],
];

/** Browsers, whose tabs hold web calls (Meet, Zoom, Teams on the web...). */
const BROWSERS = /chrom|firefox|brave|edge|vivaldi|opera|epiphany|librewolf|zen/i;

/** The call service a window title names, or null. */
function serviceOf(title) {
    return SERVICES.find(([pattern]) => pattern.test(title ?? ''))?.[1] ?? null;
}

/** The lower-case names a stream goes by: its app's id, name and icon. */
function streamKeys(stream) {
    const iconName = stream.get_icon_name();
    return [stream.get_application_id(), stream.get_name(), iconName === DEFAULT_STREAM_ICON ? null : iconName]
        .filter(Boolean)
        .map(key => key.toLowerCase().replace(/\.desktop$/, ''));
}

/** Whether `app` is the one a stream with `keys` comes from ("Google Chrome", "firefox_firefox"…). */
function appMatches(app, keys) {
    const executable = app.get_app_info()?.get_executable();
    const names = [app.get_id()?.replace(/\.desktop$/, ''), app.get_name(), executable && GLib.path_get_basename(executable)]
        .filter(Boolean)
        .map(name => name.toLowerCase());
    return keys.some(key => names.some(name =>
        key === name || (name.length >= 4 && key.includes(name)) || (key.length >= 4 && name.includes(key))));
}

/** Signals: `changed` (the call, its window or the mute), `started`. */
export class CallMonitor extends Signals.EventEmitter {
    constructor(privacy, settings) {
        super();
        this._privacy = privacy;
        this._settings = settings;
        this._mixer = getMixerControl();
        this._appSystem = Shell.AppSystem.get_default();
        this.active = false;
        /** GLib monotonic time (µs) when the call started. */
        this.since = 0;
        this.app = null;
        this.window = null;
        /** The call's microphone stream. */
        this._stream = null;
        /** The call service the call's window named, kept for the whole call. */
        this._service = null;
        this._streamName = null;
        this._heldSince = 0;
        this._timeouts = {start: 0, end: 0};
        this._source = null;
        this._sourceIds = [];
        this._windowIds = [];

        this._mixerIds = [
            ...['stream-added', 'stream-removed'].map(signal => this._mixer.connect(signal, () => this._sync())),
            ...['default-source-changed', 'state-changed'].map(signal => this._mixer.connect(signal, () => this._watchSource())),
        ];
        this._settingsId = settings.connect('changed::call-activity', () => this._sync());
        // The camera makes it a video call; screen sharing hides the preview.
        this._privacyId = privacy.connect('changed', () => this._changed());
        this._watchSource();
        this._sync();
    }

    /** Whether the camera is on too. */
    get video() {
        return this.active && this._privacy.camera;
    }

    /** Whether the microphone (GNOME's default input) is muted, for every app. */
    get muted() {
        return this._source?.is_muted ?? false;
    }

    toggleMuted() {
        this._source?.change_is_muted(!this.muted);
    }

    /** Whether an app besides the call's is using the microphone, which then still gets its dot. */
    get othersRecording() {
        if (!this.active)
            return false;
        return this._mixer.get_source_outputs().some(stream =>
            !LEVEL_METERS.includes(stream.get_application_id()) && stream !== this._stream &&
            !(this.app && appMatches(this.app, streamKeys(stream))));
    }

    /** The call's service ("Google Meet") once its window named one, else its app's name. */
    get name() {
        return this._service ?? this.app?.get_name() ?? this._streamName ?? 'Call';
    }

    get gicon() {
        return this.app?.get_icon() ?? null;
    }

    /** Brings the call's window, or else its app, to the front. */
    raise() {
        if (this.window)
            Main.activateWindow(this.window);
        else
            this.app?.activate();
    }

    _changed() {
        if (this.active)
            this.emit('changed');
    }

    /** The microphone stream of a call, or null. */
    _callStream() {
        if (!this._settings.get_boolean('call-activity'))
            return null;
        return this._mixer.get_source_outputs().find(stream => {
            if (LEVEL_METERS.includes(stream.get_application_id()))
                return false;
            return !streamKeys(stream).some(key => RECORDERS.some(recorder => key.includes(recorder)));
        }) ?? null;
    }

    _sync() {
        const stream = this._callStream();
        this._stream = stream;
        if (stream) {
            this._cancel('end');
            if (this.active) {
                // Another app may have started or stopped recording too.
                this._identify(stream);
                this.emit('changed');
            } else if (!this._timeouts.start) {
                this._heldSince = GLib.get_monotonic_time();
                this._later('start', START_DELAY_MS, () => this._begin());
            }
            return;
        }
        this._cancel('start');
        // Turned off in the settings, it ends at once.
        if (this.active && !this._timeouts.end)
            this._later('end', this._settings.get_boolean('call-activity') ? END_DELAY_MS : 0, () => this._end());
    }

    _begin() {
        const stream = this._callStream();
        if (!stream)
            return;
        this.active = true;
        this.since = this._heldSince;
        this._identify(stream);
        this.emit('started');
        this.emit('changed');
    }

    _end() {
        this.active = false;
        this.since = 0;
        this.app = null;
        this._streamName = null;
        this._setWindow(null);
        this._service = null;
        this.emit('changed');
    }

    /** Finds the app and window of `stream`; returns whether they changed. */
    _identify(stream) {
        const keys = streamKeys(stream);
        const app = this._appSystem.get_running().find(candidate => appMatches(candidate, keys)) ?? null;
        this._streamName = stream.get_name() || null;
        const service = this._service;
        const window = this._chooseWindow(app);
        if (app === this.app && window === this.window && service === this._service)
            return false;
        this.app = app;
        this._setWindow(window);
        return true;
    }

    // The call keeps the window it was found in: one titled after a call service, else the app's window
    // in front when it began. A guess gives way to a service's window; switching tabs moves nothing.
    _chooseWindow(app, leaving = null) {
        const usable = window => window !== leaving && window.get_window_type() === Meta.WindowType.NORMAL &&
            !window.is_skip_taskbar();
        // Most recently used first.
        const appWindows = app ? app.get_windows().filter(usable) : [];
        // A browser's web app (Meet, WhatsApp Web) may run in a window the shell files under another app.
        const inBrowser = !app || appWindows.some(window => BROWSERS.test(window.get_wm_class() ?? ''));
        const browserWindows = inBrowser
            ? global.display.list_all_windows().filter(window => usable(window) && BROWSERS.test(window.get_wm_class() ?? ''))
            : [];
        const candidates = [...new Set([...appWindows, ...browserWindows])];
        const current = candidates.includes(this.window) ? this.window : null;
        if (current && this._service)
            return current;
        const named = candidates.find(window => serviceOf(window.get_title()));
        if (named) {
            this._service = serviceOf(named.get_title());
            return named;
        }
        // Without a known app only a browser's call tab will do (not an editor showing "signal.rs").
        return current ?? appWindows.find(window => window.has_focus()) ?? appWindows[0] ?? null;
    }

    _setWindow(window) {
        if (window === this.window)
            return;
        this._windowIds.forEach(id => this.window.disconnect(id));
        this._windowIds = [];
        this.window = window;
        if (!window)
            return;
        this._windowIds = [
            window.connect('unmanaged', () => {
                this._service = null;
                this._setWindow(this._chooseWindow(this.app, window));
                this._changed();
            }),
            // The call's tab came to the front: now the window is known for sure.
            window.connect('notify::title', () => {
                if (GLib.get_monotonic_time() - this.since < SERVICE_GRACE_US)
                    this._service ??= serviceOf(window.get_title());
                this._changed();
            }),
            window.connect('notify::minimized', () => this._changed()),
        ];
    }

    _watchSource() {
        this._sourceIds.forEach(id => this._source.disconnect(id));
        this._sourceIds = [];
        this._source = this._mixer.get_default_source();
        if (this._source)
            this._sourceIds = [this._source.connect('notify::is-muted', () => this._changed())];
        this._changed();
    }

    _later(name, ms, callback) {
        this._timeouts[name] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts[name] = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancel(name) {
        if (this._timeouts[name]) {
            GLib.source_remove(this._timeouts[name]);
            this._timeouts[name] = 0;
        }
    }

    destroy() {
        // Tell no one about changes made while tearing down.
        this.disconnectAll();
        this._cancel('start');
        this._cancel('end');
        this._setWindow(null);
        this._sourceIds.forEach(id => this._source.disconnect(id));
        this._mixerIds.forEach(id => this._mixer.disconnect(id));
        this._settings.disconnect(this._settingsId);
        this._privacy.disconnect(this._privacyId);
    }
}
