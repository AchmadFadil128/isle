// SPDX-License-Identifier: GPL-3.0-or-later

// Focus timer (Pomodoro), the left half of the Focus page (focus.js): a ring with the time left, the
// phase, today's total and controls. See docs/product-spec.md.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {timerColor} from '../compact.js';
import {VERTICAL} from '../compat.js';
import * as Format from '../format.js';
import {Ring, chipButton, iconButton, label, setButtonIcon, setChip, setEnabled} from '../widgets.js';
import {Page} from './page.js';

const CAPTIONS = {
    idle: 'Focus time',
    focus: 'Focus time',
    short_break: 'Short break',
    long_break: 'Long break',
};
const RING_SIZE = 96;
/** Shown until isled reports the timer: a fresh 25-minute focus session. */
const DEFAULT_STATE = {phase: 'idle', running: false, remaining_ms: 25 * 60000, duration_ms: 25 * 60000, today_sessions: 0};

export const TimerPage = GObject.registerClass(
class TimerPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-timer',
            // St's `spacing` only reaches St.BoxLayout, so it is set here.
            layout_manager: new Clutter.BoxLayout({spacing: 16}),
            height,
        });
        this.name = 'focus';

        // A ring that fills clockwise as the phase runs, the time inside.
        this._time = label('25:00', 'isle-timer-time');
        this._ring = new Ring({size: RING_SIZE, lineWidth: 5, trackOpacity: 0.14, child: this._time});
        this._ring.y_align = Clutter.ActorAlign.CENTER;
        this.add_child(this._ring);

        const side = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'isle-timer-side'});
        this._caption = label('', 'isle-timer-caption');
        // Today's focus, or how to begin.
        this._stats = label('', 'isle-timer-stats');
        side.add_child(this._caption);
        side.add_child(this._stats);

        const buttons = new St.BoxLayout({style_class: 'isle-timer-buttons'});
        this._play = iconButton('isle-play-symbolic', 'isle-play-pill', () => this._toggle(),
            {size: 16, accessibleName: 'Start or pause'});
        this._reset = iconButton('isle-reset', 'isle-button-round isle-button-small',
            () => daemon.call('pomodoro', 'Stop'), {size: 14, accessibleName: 'Reset the timer'});
        this._shortBreak = chipButton('isle-coffee', 'Break',
            () => daemon.call('pomodoro', 'StartPhase', 'short_break'), 'isle-chip-break');
        this._focus = chipButton('isle-target', 'Focus',
            () => daemon.call('pomodoro', 'StartPhase', 'focus'), 'isle-chip-focus');
        for (const button of [this._play, this._reset, this._shortBreak, this._focus])
            buttons.add_child(button);
        side.add_child(buttons);
        this.add_child(side);

        this.watch(['pomodoro'], () => this._update());
        this._update();
    }

    get relevant() {
        const state = this.daemon.state.pomodoro;
        return Boolean(state && state.phase !== 'idle');
    }

    _toggle() {
        const state = this.daemon.state.pomodoro;
        this.daemon.call('pomodoro', state?.running ? 'Pause' : 'Start');
    }

    _update() {
        const state = this.daemon.state.pomodoro ?? DEFAULT_STATE;
        const idle = state.phase === 'idle';
        const remaining = this._remaining(state);

        this._ring.color = timerColor(state.phase);
        this._ring.progress = idle ? 0 : 1 - remaining / state.duration_ms;
        this._time.text = Format.duration(remaining);
        this._caption.text = state.running || idle ? CAPTIONS[state.phase] : `${CAPTIONS[state.phase]} · paused`;

        const sessions = state.today_sessions ?? 0;
        const length = Format.hoursMinutes(state.duration_ms);
        const onBreak = state.phase === 'short_break' || state.phase === 'long_break';
        if (sessions > 0)
            this._stats.text = `Today · ${sessions} ${sessions === 1 ? 'session' : 'sessions'} · ${Format.hoursMinutes(state.today_focus_ms ?? 0)}`;
        else
            this._stats.text = onBreak ? `${length} break, then back to focus` : `${length} of focus, then a break`;

        setButtonIcon(this._play, state.running ? 'isle-pause-symbolic' : 'isle-play-symbolic');
        // Reset only acts once started.
        setEnabled(this._reset, !idle);

        // The chip of the current phase lights up in its colour and its icon
        // fills in, like Do Not Disturb.
        const focus = state.phase === 'focus';
        setChip(this._shortBreak, {
            active: onBreak,
            icon: onBreak ? 'isle-coffee-fill' : 'isle-coffee',
        });
        setChip(this._focus, {active: focus, icon: focus ? 'isle-target-fill' : 'isle-target'});

        this._scheduleTick(state);
    }

    _remaining(state) {
        return state.running ? Math.max(0, state.ends_at_ms - Format.nowMs()) : state.remaining_ms;
    }

    /** Re-renders just after the displayed second changes. */
    _scheduleTick(state) {
        if (!this.active || !state.running)
            return;
        const remaining = this._remaining(state);
        // At zero, isled's PhaseFinished brings the next state.
        if (remaining <= 0)
            return;
        this.later('tick', (remaining % 1000) + 15, () => this._update());
    }

    onActivate() {
        this._update();
    }
});
