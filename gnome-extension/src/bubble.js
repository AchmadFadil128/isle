// SPDX-License-Identifier: GPL-3.0-or-later

// The bubble beside the closed island, as on an iPhone: a second activity when the island already shows
// another. The timer and a call say their time in a capsule; music is a round bubble of bars. It splits off
// the island's edge and slides back into it.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {timerColor} from './compact.js';
import * as Format from './format.js';
import * as Playback from './playback.js';
import {Bars, Ring, icon, label} from './widgets.js';

/** Between the island and the bubble, in px. */
const GAP = 6;
const SPLIT_MS = 380;
const MERGE_MS = 200;

const css = ([r, g, b]) => `color: rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)});`;

export const IslandBubble = GObject.registerClass({
    Signals: {'clicked': {}},
}, class IslandBubble extends St.Button {
    _init(daemon, call) {
        super._init({style_class: 'isle-bubble', can_focus: false, visible: false, opacity: 0});
        this._daemon = daemon;
        this._call = call;
        /** What it shows: 'timer', 'music', 'call', or null. */
        this.kind = null;
        this._idle = false;
        this._tick = 0;

        // The timer: its ring and the time left. A call: the green phone and how long it has lasted.
        this._timer = new St.BoxLayout({style_class: 'isle-bubble-capsule'});
        this._ring = new Ring({size: 16, lineWidth: 2.5, trackOpacity: 0.2});
        this._timerText = label('', 'isle-bubble-time', {y_align: Clutter.ActorAlign.CENTER});
        this._timer.add_child(this._ring);
        this._timer.add_child(this._timerText);
        this._callBox = new St.BoxLayout({style_class: 'isle-bubble-capsule isle-bubble-call'});
        this._callBox.add_child(new St.Icon({gicon: icon('isle-phone-symbolic'), icon_size: 13, y_align: Clutter.ActorAlign.CENTER}));
        this._callText = label('', 'isle-bubble-time', {y_align: Clutter.ActorAlign.CENTER});
        this._callBox.add_child(this._callText);
        this._bars = new Bars({height: 13});

        this.set_pivot_point(0, 0.5);
        this._changed = daemon.connect('changed', (_daemon, key) => {
            if (key === 'pomodoro' || key === 'nowPlaying')
                this._sync();
        });
        this.connect('notify::mapped', () => this._sync());
        this.connect('destroy', () => {
            daemon.disconnect(this._changed);
            this._stopTick();
        });
    }

    /** Away from the keyboard and pointer: the bars rest, as on the island. */
    set idle(idle) {
        this._idle = idle;
        this._sync();
    }

    /** Shows `kind` beside the island (`rect`: the island's body on screen), or none. */
    show(kind, rect) {
        if (kind === this.kind && this.visible)
            return;
        const appearing = !this.kind || !this.visible;
        this.kind = kind;
        if (!kind) {
            this.hideAway();
            return;
        }
        const child = {timer: this._timer, music: this._bars, call: this._callBox}[kind];
        if (this.child !== child)
            this.child = child;
        this._sync();
        this.place(rect);
        if (!appearing)
            return;
        // Out of the island's edge: from inside it, small, to its own place.
        this.remove_all_transitions();
        this.visible = true;
        this.set({opacity: 0, translation_x: -(this.width + GAP), scale_x: 0.5, scale_y: 0.5});
        this.ease({opacity: 255, translation_x: 0, scale_x: 1, scale_y: 1, duration: SPLIT_MS,
            mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }

    /** Back into the island, and gone. */
    hideAway() {
        this.kind = null;
        this._stopTick();
        if (!this.visible)
            return;
        this.remove_all_transitions();
        this.ease({opacity: 0, translation_x: -(this.width + GAP), scale_x: 0.5, scale_y: 0.5, duration: MERGE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: () => this.hide()});
    }

    /** Beside `rect` (the island's body on screen): as tall as it, round or a capsule, at its top. */
    place(rect) {
        if (!rect)
            return;
        const size = Math.max(0, rect.height - 2);
        this.height = size;
        // Round for the bars; as wide as its text otherwise.
        this.style = `min-width: ${size}px;`;
        this.set_position(Math.round(rect.x + rect.width + GAP), rect.y + 1);
    }

    _sync() {
        const {nowPlaying, pomodoro} = this._daemon.state;
        this._bars.playing = this.mapped && this.kind === 'music' && !this._idle && Playback.isPlaying(nowPlaying);
        this._stopTick();
        if (!this.mapped)
            return;
        let next = 0;
        if (this.kind === 'timer' && pomodoro && pomodoro.phase !== 'idle') {
            const remaining = pomodoro.running ? Math.max(0, pomodoro.ends_at_ms - Format.nowMs()) : pomodoro.remaining_ms;
            const color = timerColor(pomodoro.phase);
            this._ring.color = color;
            this._ring.progress = 1 - remaining / pomodoro.duration_ms;
            this._timerText.text = Format.duration(remaining);
            this._timerText.style = css(color);
            if (pomodoro.running)
                next = remaining % 1000 || 1000;
        } else if (this.kind === 'call' && this._call.active) {
            const elapsedMs = (GLib.get_monotonic_time() - this._call.since) / 1000;
            this._callText.text = Format.duration(elapsedMs);
            next = 1000 - (elapsedMs % 1000);
        }
        // The next second, while the time moves and it is on screen.
        if (next) {
            this._tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(next) + 10, () => {
                this._tick = 0;
                this._sync();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _stopTick() {
        if (this._tick)
            GLib.source_remove(this._tick);
        this._tick = 0;
    }
});
