// SPDX-License-Identifier: GPL-3.0-or-later

// The resting island: the clock, flanked by live activities (a running
// focus timer on the left, music on the right), or sleepy eyes when idle.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Format from './format.js';
import * as Playback from './playback.js';
import {Art, Bars, Eyes, Ring, icon} from './widgets.js';

const WIDTH_CLOCK = 150;
const WIDTH_ACTIVITIES = 232;
const WIDTH_LYRICS = 400;
/** How often the focus ring is redrawn; it moves too slowly to need more. */
const RING_REFRESH_S = 5;
/** The focus timer's colour: white while focusing, green on a break. */
export function timerColor(phase) {
    return phase === 'focus' || phase === 'idle' ? [1, 1, 1] : [0.2, 0.88, 0.48];
}

export const CompactView = GObject.registerClass({
    Signals: {'width-changed': {}},
}, class CompactView extends St.Widget {
    _init(daemon, settings) {
        super._init({
            style_class: 'isle-compact',
            layout_manager: new Clutter.BinLayout(),
        });
        this._daemon = daemon;
        this._settings = settings;
        this._eyesShown = false;
        this._timeouts = {};

        const row = new St.BoxLayout({style_class: 'isle-compact-row', x_expand: true, y_expand: true});
        this.add_child(row);

        this._left = new St.Bin({style_class: 'isle-compact-slot', y_align: Clutter.ActorAlign.CENTER});
        this._ring = new Ring({size: 16, lineWidth: 2.5});
        this._art = new Art({size: 20, radius: 5});
        this._dot = new St.Widget({style_class: 'isle-unseen-dot', y_align: Clutter.ActorAlign.CENTER});
        this._moon = new St.Icon({gicon: icon('isle-moon'), icon_size: 13, style_class: 'isle-dnd-moon', y_align: Clutter.ActorAlign.CENTER});

        const center = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        this._clock = new St.Label({style_class: 'isle-compact-clock', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        // Fills the centre so long lines are cut off with an ellipsis.
        this._lyric = new St.Label({style_class: 'isle-compact-lyric', x_expand: true, y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._lyric.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._eyes = new Eyes();
        this._eyes.x_align = Clutter.ActorAlign.CENTER;
        this._eyes.visible = false;
        center.add_child(this._clock);
        center.add_child(this._lyric);
        center.add_child(this._eyes);

        this._right = new St.Bin({style_class: 'isle-compact-slot', y_align: Clutter.ActorAlign.CENTER});
        this._bars = new Bars({height: 13});

        row.add_child(this._left);
        row.add_child(center);
        row.add_child(this._right);

        this._daemonChanged = daemon.connect('changed', (_daemon, key) => {
            if (['nowPlaying', 'lyrics', 'pomodoro'].includes(key))
                this._refresh();
        });
        this._settingsChanged = settings.connect('changed::compact-lyrics', () => this._refresh());
        this._tickClock();
        this._refresh();
    }

    /** The width the island should have to fit what is shown. */
    get preferredWidth() {
        if (this._showingLyrics())
            return WIDTH_LYRICS;
        return this._left.child || this._right.child ? WIDTH_ACTIVITIES : WIDTH_CLOCK;
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

    /** Swaps the clock for eyes that slowly fall asleep. */
    doze() {
        if (Playback.isPlaying(this._daemon.state.nowPlaying))
            return;
        this._eyesShown = true;
        this._crossfade(this._eyes);
        this._eyes.doze();
    }

    /** Wakes the eyes up, then goes back to the clock. */
    wake() {
        if (!this._eyesShown)
            return;
        this._eyes.wake();
        this._later('wake', 1200, () => {
            this._eyesShown = false;
            this._refresh();
        });
    }

    _showingLyrics() {
        const {nowPlaying, lyrics} = this._daemon.state;
        return this._settings.get_boolean('compact-lyrics') &&
            Playback.isPlaying(nowPlaying) && Playback.hasSyncedLyrics(lyrics);
    }

    _refresh() {
        const {nowPlaying, pomodoro} = this._daemon.state;
        const playing = Playback.isPlaying(nowPlaying);
        const timerActive = pomodoro && pomodoro.phase !== 'idle';
        const widthBefore = this.preferredWidth;

        // Left: the focus timer, else cover art, else the unread dot, else the
        // Do Not Disturb moon. Both slots keep their width when empty, so the
        // clock stays centred.
        let left = null;
        if (timerActive)
            left = this._ring;
        else if (playing)
            left = this._art;
        else if (this._unseen)
            left = this._dot;
        else if (this._dnd)
            left = this._moon;
        if (this._left.child !== left)
            this._left.child = left;
        this._right.child = playing ? this._bars : null;

        if (timerActive) {
            this._ring.color = timerColor(pomodoro.phase);
            this._refreshRing();
        } else {
            this._cancel('ring');
        }
        if (playing)
            this._art.setPath(nowPlaying.art_path);

        if (!this._eyesShown) {
            const lyrics = this._showingLyrics();
            this._crossfade(lyrics ? this._lyric : this._clock);
            if (lyrics)
                this._tickLyric();
            else
                this._cancel('lyric');
        }

        if (this.preferredWidth !== widthBefore)
            this.emit('width-changed');
    }

    /** Fades `actor` in and the other centre actors out. */
    _crossfade(actor) {
        for (const other of [this._clock, this._lyric, this._eyes]) {
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

    /** Updates the clock, then sleeps until the minute changes. */
    _tickClock() {
        const now = GLib.DateTime.new_now_local();
        this._clock.text = Format.clockTime(now);
        const msIntoMinute = now.get_second() * 1000 + Math.floor(now.get_microsecond() / 1000);
        this._later('clock', 60000 - msIntoMinute + 20, () => this._tickClock());
    }

    /** Shows the current lyric line, then sleeps until the next one starts. */
    _tickLyric() {
        const {nowPlaying, lyrics} = this._daemon.state;
        const lines = lyrics.lines;
        const index = Playback.lineIndexAt(lines, Playback.positionMs(nowPlaying));
        const text = index >= 0 ? lines[index].text : '';
        // Instrumental gaps show a note rather than an empty island.
        this._lyric.text = text || '♪';
        const wait = Playback.msUntilLine(nowPlaying, lines, index);
        if (wait === null)
            this._cancel('lyric');
        else
            this._later('lyric', wait + 30, () => this._tickLyric());
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

    vfunc_destroy() {
        for (const name of Object.keys(this._timeouts))
            this._cancel(name);
        this._daemon.disconnect(this._daemonChanged);
        this._settings.disconnect(this._settingsChanged);
        // Slots may hold actors that are not currently children.
        for (const actor of [this._ring, this._art, this._dot, this._moon, this._bars]) {
            if (!actor.get_parent())
                actor.destroy();
        }
        super.vfunc_destroy();
    }
});
