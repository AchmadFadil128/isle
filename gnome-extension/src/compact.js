// SPDX-License-Identifier: GPL-3.0-or-later

// The resting island: the clock flanked by live activities (recording, call or timer
// left, music right, privacy dots far right). A paused song keeps its cover.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Format from './format.js';
import * as Palette from './palette.js';
import * as Playback from './playback.js';
import {watchClock} from './wallClock.js';
import {Art, Bars, PrivacyDots, RecordingDot, Ring, icon} from './widgets.js';

/** Sizes hanging below the top bar, and inside it with smaller text. */
const SIZES = {
    hanging: {clock: 164, activities: 256, art: 24, artRadius: 6, ring: 20, bars: 16, moon: 13, call: 15},
    inBar: {clock: 144, activities: 232, art: 22, artRadius: 6, ring: 18, bars: 14, moon: 12, call: 14},
};
/** The music bars' opacity while the song is paused. */
const PAUSED_OPACITY = 110;
/** How often the focus ring is redrawn; it moves too slowly to need more. */
const RING_REFRESH_S = 5;
/** The focus timer's colour: white while focusing, green on a break. */
export function timerColor(phase) {
    return phase === 'focus' || phase === 'idle' ? Palette.WHITE : Palette.GREEN;
}

export const CompactView = GObject.registerClass({
    Signals: {'width-changed': {}},
}, class CompactView extends St.Widget {
    _init(daemon, settings, privacy, call) {
        super._init({
            style_class: 'isle-compact',
            layout_manager: new Clutter.BinLayout(),
        });
        this._daemon = daemon;
        this._settings = settings;
        this._privacy = privacy;
        this._call = call;
        this._idle = false;
        this._inBar = false;
        this._timeouts = {};

        const row = new St.BoxLayout({style_class: 'isle-compact-row', x_expand: true, y_expand: true});
        this._row = row;
        this.add_child(row);

        this._left = new St.Bin({style_class: 'isle-compact-slot', y_align: Clutter.ActorAlign.CENTER});
        this._ring = new Ring({size: 20, lineWidth: 3});
        this._art = new Art({size: 24, radius: 6});
        this._dot = new St.Widget({style_class: 'isle-unseen-dot', y_align: Clutter.ActorAlign.CENTER});
        this._moon = new St.Icon({gicon: icon('isle-moon'), icon_size: 13, style_class: 'isle-dnd-moon', y_align: Clutter.ActorAlign.CENTER});
        this._recordingDot = new RecordingDot();
        // A call: a green phone, and on the right a red microphone while it is muted.
        this._phone = new St.Icon({gicon: icon('isle-phone-symbolic'), icon_size: 15, style_class: 'isle-call-icon', y_align: Clutter.ActorAlign.CENTER});
        this._micOff = new St.Icon({gicon: icon('isle-mic-off-symbolic'), icon_size: 15, style_class: 'isle-call-muted', y_align: Clutter.ActorAlign.CENTER});
        // isled is not running: what needs it cannot work (see the controller's service watch).
        this._serviceDown = new St.Icon({gicon: icon('dialog-warning-symbolic'), icon_size: 15, style_class: 'isle-compact-warning', y_align: Clutter.ActorAlign.CENTER});
        // The assistant at work with the island closed: still, so it costs no frames.
        this._assistant = new St.Icon({gicon: icon('isle-mic-symbolic'), icon_size: 15, style_class: 'isle-compact-assistant', y_align: Clutter.ActorAlign.CENTER});

        const center = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        this._clock = new St.Label({style_class: 'isle-compact-clock', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        // How long the screen has been recording, in place of the clock.
        this._elapsed = new St.Label({style_class: 'isle-compact-clock', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, visible: false});
        // How long the call has lasted, in green like an iPhone's.
        this._callTime = new St.Label({style_class: 'isle-compact-clock isle-compact-call-time', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, visible: false});
        center.add_child(this._clock);
        center.add_child(this._elapsed);
        center.add_child(this._callTime);

        this._right = new St.Bin({style_class: 'isle-compact-slot', y_align: Clutter.ActorAlign.CENTER});
        this._bars = new Bars({height: 16});

        this._privacyDots = new PrivacyDots();

        // As wide as the privacy dots at the far right, so the clock stays centred.
        this._privacyBalance = new St.Widget({visible: false});
        row.add_child(this._privacyBalance);
        row.add_child(this._left);
        row.add_child(center);
        row.add_child(this._right);
        row.add_child(this._privacyDots);

        this._daemonChanged = daemon.connect('changed', (_daemon, key) => {
            if (['nowPlaying', 'pomodoro'].includes(key))
                this._refresh();
        });
        this._settingsChanged = settings.connect('changed::privacy-indicators', () => this._refresh());
        this._privacyChanged = privacy.connect('changed', () => this._refresh());
        this._callChanged = call.connect('changed', () => this._refresh());
        // Music bars only dance, and the times and the timer's ring only tick, while this view is on screen.
        this.connect('notify::mapped', () => {
            this._syncBars();
            this._tickCall();
            this._tickRecording();
            this._refreshRing();
            // Measure the privacy dots' balance now that they can be.
            if (this.mapped && this._privacyBalance.visible && !this._privacyBalance.width)
                this._refresh();
        });
        this._tickClock();
        this._stopClock = watchClock(() => this._tickClock());
        this._refresh();
        this.connect('destroy', () => this._onDestroy());
    }

    /** The width the island should have to fit what is shown. */
    get preferredWidth() {
        const size = SIZES[this._inBar ? 'inBar' : 'hanging'];
        const privacy = this._privacyWidth();
        return (this._left.child || this._right.child ? size.activities : size.clock) + privacy;
    }

    /** Room for the privacy dots and their balance on the other side (none inside a slot). */
    _privacyWidth() {
        // Off the stage (as when Isle starts mid-call) nothing can be measured yet.
        if (!this._privacyDots.visible || this._privacyDots.get_parent() !== this._row || !this.get_stage())
            return 0;
        const [, dots] = this._privacyDots.get_preferred_width(-1);
        const spacing = this._row.get_theme_node().get_length('spacing');
        return 2 * Math.ceil(dots + spacing);
    }

    _showingPrivacy() {
        return this._settings.get_boolean('privacy-indicators') && this._privacy.any;
    }

    /** Shows a dot for unseen notifications when nothing else is on the left. */
    set unseenNotifications(unseen) {
        if (unseen === this._unseen)
            return;
        this._unseen = unseen;
        this._refresh();
    }

    /** Shows a moon while Do Not Disturb is on and nothing else is on the left. */
    set doNotDisturb(on) {
        this._dnd = on;
        this._refresh();
    }

    /** Shows that isled is not running, on the right before anything else. */
    get serviceDown() {
        return Boolean(this._isServiceDown);
    }

    set serviceDown(down) {
        if (down === Boolean(this._isServiceDown))
            return;
        this._isServiceDown = down;
        this._refresh();
    }

    /** Shows that the assistant works on a request, on the right, first of all. */
    set assistantBusy(busy) {
        if (busy === Boolean(this._assistantBusy))
            return;
        this._assistantBusy = busy;
        this._refresh();
    }

    /** Fits the view inside the top bar, like a MacBook's notch, or below it. */
    set inBar(inBar) {
        if (inBar === this._inBar)
            return;
        this._inBar = inBar;
        const size = SIZES[inBar ? 'inBar' : 'hanging'];
        this._art.resize(size.art, size.artRadius);
        this._ring.set_size(size.ring, size.ring);
        this._bars.maxHeight = size.bars;
        this._moon.icon_size = size.moon;
        this._phone.icon_size = this._micOff.icon_size = size.call;
        if (inBar)
            this.add_style_class_name('isle-compact-in-bar');
        else
            this.remove_style_class_name('isle-compact-in-bar');
    }

    /** While the user is away the music bars rest; nobody is watching them. */
    /** Whether the user is away (no input for a while); the bars rest meanwhile. */
    get idle() {
        return this._idle;
    }

    set idle(idle) {
        this._idle = idle;
        this._syncBars();
    }

    _refresh() {
        const {nowPlaying, pomodoro} = this._daemon.state;
        const playing = Playback.isPlaying(nowPlaying);
        // A paused song stays, like NotchNook, until its player closes.
        const hasTrack = Playback.hasTrack(nowPlaying);
        const timerActive = pomodoro && pomodoro.phase !== 'idle';
        const recording = this._privacy.recording;
        const onCall = this._call.active;
        const widthBefore = this.preferredWidth;

        // Left, first that applies: recording, call, focus timer, cover, unread dot, DND.
        // Both slots keep their width when empty, so the centre stays centred.
        let left = null;
        if (recording)
            left = this._recordingDot;
        else if (onCall)
            left = this._phone;
        else if (timerActive)
            left = this._ring;
        else if (hasTrack)
            left = this._art;
        else if (this._unseen)
            left = this._dot;
        else if (this._dnd)
            left = this._moon;
        if (this._left.child !== left)
            this._left.child = left;
        let right = hasTrack ? this._bars : null;
        if (onCall && this._call.muted)
            right = this._micOff;
        if (this._assistantBusy)
            right = this._assistant;
        if (this._isServiceDown)
            right = this._serviceDown;
        // On a call the green phone already says the microphone is on, as on an iPhone, unless another app records too.
        const privacy = this._showingPrivacy() ? this._privacy : {};
        const microphone = privacy.microphone && (!onCall || this._call.othersRecording);
        const dots = {camera: privacy.camera, microphone, screenShare: privacy.screenShare};
        this._privacyDots.update(dots);
        // Beside an activity, up to two dots take the empty right slot, so the island grows no wider.
        const shown = Object.values(dots).filter(Boolean).length;
        const inSlot = shown > 0 && shown <= 2 && Boolean(left) && !right;
        if (inSlot) {
            right = this._privacyDots;
            if (this._privacyDots.get_parent() === this._row)
                this._row.remove_child(this._privacyDots);
        }
        if (this._right.child !== right)
            this._right.child = right;
        if (!inSlot && !this._privacyDots.get_parent())
            this._row.add_child(this._privacyDots);
        if (inSlot)
            this._privacyDots.add_style_class_name('isle-privacy-dots-in-slot');
        else
            this._privacyDots.remove_style_class_name('isle-privacy-dots-in-slot');
        // Paused: the bars rest, dimmed.
        this._bars.ease({opacity: playing ? 255 : PAUSED_OPACITY, duration: 200});
        this._syncBars();
        const outside = this._privacyDots.visible && !inSlot;
        this._privacyBalance.visible = outside;
        // Measured only when shown: hidden, it may not be on the stage yet.
        this._privacyBalance.width = outside && this.get_stage() ? this._privacyDots.get_preferred_width(-1)[1] : 0;

        if (timerActive) {
            this._ring.color = timerColor(pomodoro.phase);
            this._refreshRing();
        } else {
            this._cancel('ring');
        }
        if (hasTrack)
            this._art.setPath(nowPlaying.art_path);

        if (recording) {
            this._crossfade(this._elapsed);
            this._tickRecording();
        } else {
            this._cancel('recording');
            this._crossfade(onCall ? this._callTime : this._clock);
        }
        this._tickCall();

        if (this.preferredWidth !== widthBefore)
            this.emit('width-changed');
    }

    /** Fades `actor` in and the other centre actors out. */
    _crossfade(actor) {
        for (const other of [this._clock, this._elapsed, this._callTime]) {
            if (other === actor) {
                if (!other.visible) {
                    other.opacity = 0;
                    other.show();
                }
                other.ease({opacity: 255, duration: 200});
            } else if (other.visible) {
                other.ease({opacity: 0, duration: 150, onComplete: () => other.hide()});
            }
        }
    }

    _refreshRing() {
        const {pomodoro} = this._daemon.state;
        if (!pomodoro || pomodoro.phase === 'idle' || !this.mapped) {
            this._cancel('ring');
            return;
        }
        const remaining = pomodoro.running
            ? Math.max(0, pomodoro.ends_at_ms - Format.nowMs())
            : pomodoro.remaining_ms;
        this._ring.progress = 1 - remaining / pomodoro.duration_ms;
        if (pomodoro.running)
            this._later('ring', RING_REFRESH_S * 1000, () => this._refreshRing());
    }

    _syncBars() {
        this._bars.playing = this.mapped && !this._idle && Playback.isPlaying(this._daemon.state.nowPlaying);
    }

    /** Shows how long the screen has been recording, once a second while on screen. */
    _tickRecording() {
        if (!this._privacy.recording || !this.mapped) {
            this._cancel('recording');
            return;
        }
        const elapsedMs = (GLib.get_monotonic_time() - this._privacy.recordingSince) / 1000;
        this._elapsed.text = Format.duration(elapsedMs);
        this._later('recording', 1000 - (elapsedMs % 1000) + 10, () => this._tickRecording());
    }

    /** Shows how long the call has lasted, once a second while on screen. */
    _tickCall() {
        if (!this._call.active || !this.mapped) {
            this._cancel('call');
            return;
        }
        const elapsedMs = (GLib.get_monotonic_time() - this._call.since) / 1000;
        this._callTime.text = Format.duration(elapsedMs);
        this._later('call', 1000 - (elapsedMs % 1000) + 10, () => this._tickCall());
    }

    /** Updates the clock, then sleeps until the minute changes. */
    _tickClock() {
        this._clock.text = Format.clockTime();
    }

    _later(name, ms, callback) {
        this._cancel(name);
        this._timeouts[name] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, Math.round(ms)), () => {
            delete this._timeouts[name];
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancel(name) {
        if (this._timeouts[name]) {
            GLib.source_remove(this._timeouts[name]);
            delete this._timeouts[name];
        }
    }

    _onDestroy() {
        this._stopClock();
        for (const name of Object.keys(this._timeouts))
            this._cancel(name);
        this._daemon.disconnect(this._daemonChanged);
        this._settings.disconnect(this._settingsChanged);
        this._privacy.disconnect(this._privacyChanged);
        this._call.disconnect(this._callChanged);
        // Slots may hold actors that are not currently children.
        for (const actor of [this._ring, this._art, this._dot, this._moon, this._recordingDot, this._bars, this._phone, this._micOff, this._assistant, this._serviceDown]) {
            if (!actor.get_parent())
                actor.destroy();
        }
    }
});
