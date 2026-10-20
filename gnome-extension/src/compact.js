// SPDX-License-Identifier: GPL-3.0-or-later

// The resting island: the clock, flanked by live activities (a screen
// recording or focus timer on the left, music on the right, privacy dots at
// the far right). A paused song keeps its cover, with the bars at rest.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Format from './format.js';
import * as Playback from './playback.js';
import {Art, Bars, PrivacyDots, RecordingDot, Ring, icon} from './widgets.js';

/** Sizes hanging below the top bar, and inside it with smaller text. */
const SIZES = {
    hanging: {clock: 164, activities: 256, art: 24, artRadius: 6, ring: 20, bars: 16, moon: 13},
    inBar: {clock: 144, activities: 232, art: 22, artRadius: 6, ring: 18, bars: 14, moon: 12},
};
/** The music bars' opacity while the song is paused. */
const PAUSED_OPACITY = 110;
/** How often the focus ring is redrawn; it moves too slowly to need more. */
const RING_REFRESH_S = 5;
/** The focus timer's colour: white while focusing, green on a break. */
export function timerColor(phase) {
    return phase === 'focus' || phase === 'idle' ? [1, 1, 1] : [0.2, 0.88, 0.48];
}

export const CompactView = GObject.registerClass({
    Signals: {'width-changed': {}},
}, class CompactView extends St.Widget {
    _init(daemon, settings, privacy) {
        super._init({
            style_class: 'isle-compact',
            layout_manager: new Clutter.BinLayout(),
        });
        this._daemon = daemon;
        this._settings = settings;
        this._privacy = privacy;
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

        const center = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        this._clock = new St.Label({style_class: 'isle-compact-clock', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        // How long the screen has been recording, in place of the clock.
        this._elapsed = new St.Label({style_class: 'isle-compact-clock', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, visible: false});
        center.add_child(this._clock);
        center.add_child(this._elapsed);

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
        // Music bars only dance while this view is on screen.
        this.connect('notify::mapped', () => this._syncBars());
        this._tickClock();
        this._refresh();
        this.connect('destroy', () => this._onDestroy());
    }

    /** The width the island should have to fit what is shown. */
    get preferredWidth() {
        const size = SIZES[this._inBar ? 'inBar' : 'hanging'];
        const privacy = this._privacyWidth();
        return (this._left.child || this._right.child ? size.activities : size.clock) + privacy;
    }

    /** Room for the privacy dots and their balance on the other side. */
    _privacyWidth() {
        if (!this._privacyDots.visible)
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
        this._unseen = unseen;
        this._refresh();
    }

    /** Shows a moon while Do Not Disturb is on and nothing else is on the left. */
    set doNotDisturb(on) {
        this._dnd = on;
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
        if (inBar)
            this.add_style_class_name('isle-compact-in-bar');
        else
            this.remove_style_class_name('isle-compact-in-bar');
    }

    /** While the user is away the music bars rest; nobody is watching them. */
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
        const widthBefore = this.preferredWidth;

        // Left, first that applies: a screen recording, the focus timer, cover
        // art, the unread dot, the Do Not Disturb moon. Both slots keep their
        // width when empty, so the centre stays centred.
        let left = null;
        if (recording)
            left = this._recordingDot;
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
        this._right.child = hasTrack ? this._bars : null;
        // Paused: the bars rest, dimmed.
        this._bars.ease({opacity: playing ? 255 : PAUSED_OPACITY, duration: 200});
        this._syncBars();
        this._privacyDots.update(this._showingPrivacy() ? this._privacy : {});
        this._privacyBalance.visible = this._privacyDots.visible;
        this._privacyBalance.width = this._privacyDots.get_preferred_width(-1)[1];

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
            this._crossfade(this._clock);
        }

        if (this.preferredWidth !== widthBefore)
            this.emit('width-changed');
    }

    /** Fades `actor` in and the other centre actors out. */
    _crossfade(actor) {
        for (const other of [this._clock, this._elapsed]) {
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
        if (!pomodoro || pomodoro.phase === 'idle')
            return;
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

    /** Shows how long the screen has been recording, once a second. */
    _tickRecording() {
        const elapsedMs = (GLib.get_monotonic_time() - this._privacy.recordingSince) / 1000;
        this._elapsed.text = Format.duration(elapsedMs);
        this._later('recording', 1000 - (elapsedMs % 1000) + 10, () => this._tickRecording());
    }

    /** Updates the clock, then sleeps until the minute changes. */
    _tickClock() {
        const now = GLib.DateTime.new_now_local();
        this._clock.text = Format.clockTime(now);
        const msIntoMinute = now.get_second() * 1000 + Math.floor(now.get_microsecond() / 1000);
        this._later('clock', 60000 - msIntoMinute + 20, () => this._tickClock());
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
        for (const name of Object.keys(this._timeouts))
            this._cancel(name);
        this._daemon.disconnect(this._daemonChanged);
        this._settings.disconnect(this._settingsChanged);
        this._privacy.disconnect(this._privacyChanged);
        // Slots may hold actors that are not currently children.
        for (const actor of [this._ring, this._art, this._dot, this._moon, this._recordingDot, this._bars]) {
            if (!actor.get_parent())
                actor.destroy();
        }
    }
});
