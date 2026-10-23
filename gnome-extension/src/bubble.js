// SPDX-License-Identifier: GPL-3.0-or-later

// The bubble beside the closed island, as on an iPhone: a second activity (the timer, the music or a call)
// when the island already shows another. It splits off the island's edge and slides back into it.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {timerColor} from './compact.js';
import * as Format from './format.js';
import * as Playback from './playback.js';
import {Bars, Ring, icon} from './widgets.js';

/** Between the island and the bubble, in px. */
const GAP = 6;
const SPLIT_MS = 380;
const MERGE_MS = 200;
/** The timer's ring moves this often; as on the closed island. */
const RING_REFRESH_MS = 5000;

export const IslandBubble = GObject.registerClass({
    Signals: {'clicked': {}},
}, class IslandBubble extends St.Button {
    _init(daemon) {
        super._init({style_class: 'isle-bubble', can_focus: false, visible: false, opacity: 0});
        this._daemon = daemon;
        /** What it shows: 'timer', 'music', 'call', or null. */
        this.kind = null;
        this._idle = false;
        this._ring = new Ring({size: 18, lineWidth: 2.5, trackOpacity: 0.2});
        this._bars = new Bars({height: 13});
        this._phone = new St.Icon({gicon: icon('isle-phone-symbolic'), icon_size: 14, style_class: 'isle-bubble-phone'});
        this._ringTimer = 0;
        this.set_pivot_point(0, 0.5);
        this.connect('clicked', () => this.emit('clicked'));
        this._changed = daemon.connect('changed', (_daemon, key) => {
            if (key === 'pomodoro' || key === 'nowPlaying')
                this._sync();
        });
        this.connect('notify::mapped', () => this._sync());
        this.connect('destroy', () => {
            daemon.disconnect(this._changed);
            this._stopRing();
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
        const child = {timer: this._ring, music: this._bars, call: this._phone}[kind];
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
        if (!this.visible)
            return;
        this.remove_all_transitions();
        this.ease({opacity: 0, translation_x: -(this.width + GAP), scale_x: 0.5, scale_y: 0.5, duration: MERGE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: () => this.hide()});
        this._stopRing();
    }

    /** Beside `rect` (the island's body on screen): as tall as it, round, at its top. */
    place(rect) {
        if (!rect)
            return;
        const size = Math.max(0, rect.height - 2);
        this.set_size(size, size);
        this.set_position(Math.round(rect.x + rect.width + GAP), rect.y + 1);
    }

    _sync() {
        const {nowPlaying, pomodoro} = this._daemon.state;
        this._bars.playing = this.mapped && this.kind === 'music' && !this._idle && Playback.isPlaying(nowPlaying);
        if (this.kind === 'timer' && this.mapped && pomodoro && pomodoro.phase !== 'idle') {
            const remaining = pomodoro.running ? Math.max(0, pomodoro.ends_at_ms - Format.nowMs()) : pomodoro.remaining_ms;
            this._ring.color = timerColor(pomodoro.phase);
            this._ring.progress = 1 - remaining / pomodoro.duration_ms;
            if (pomodoro.running && !this._ringTimer) {
                this._ringTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RING_REFRESH_MS, () => {
                    this._ringTimer = 0;
                    this._sync();
                    return GLib.SOURCE_REMOVE;
                });
            }
        } else {
            this._stopRing();
        }
    }

    _stopRing() {
        if (this._ringTimer)
            GLib.source_remove(this._ringTimer);
        this._ringTimer = 0;
    }
});
