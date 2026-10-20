// SPDX-License-Identifier: GPL-3.0-or-later

// Focus timer (Pomodoro): a ring with a stopwatch, the time remaining, and
// chips to jump between a short break and focus. See docs/product-spec.md.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {timerColor} from '../compact.js';
import * as Format from '../format.js';
import {Ring, chipButton, icon, iconButton, label, setButtonIcon, setChip, setEnabled} from '../widgets.js';
import {Page} from './page.js';

const CAPTIONS = {
    idle: 'Focus time',
    focus: 'Focus time',
    short_break: 'Short break',
    long_break: 'Long break',
};

export const TimerPage = GObject.registerClass(
class TimerPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-timer',
            layout_manager: new Clutter.BoxLayout(),
            height,
        });
        this.name = 'focus';

        // A thin ring that fills clockwise as the phase runs, a clock inside.
        this._clock = new St.Icon({gicon: icon('isle-timer'), icon_size: 28, style_class: 'isle-focus-icon'});
        this._ring = new Ring({size: 88, lineWidth: 4, trackOpacity: 0.14, child: this._clock});
        this.add_child(this._ring);

        const center = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'isle-timer-center'});

        const timeRow = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, style_class: 'isle-timer-row'});
        this._time = label('25:00', 'isle-timer-time');
        timeRow.add_child(this._time);
        this._reset = iconButton('isle-reset', 'isle-button-round isle-button-small',
            () => daemon.call('pomodoro', 'Stop'), {size: 14, accessibleName: 'Reset the timer'});
        timeRow.add_child(this._reset);
        center.add_child(timeRow);

        this._caption = label('', 'isle-timer-caption', {x_align: Clutter.ActorAlign.CENTER});
        center.add_child(this._caption);

        // Today's focus, shown once there is some.
        this._stats = label('', 'isle-timer-stats', {x_align: Clutter.ActorAlign.CENTER, visible: false});
        center.add_child(this._stats);

        const buttons = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, style_class: 'isle-timer-buttons'});
        this._shortBreak = chipButton('isle-coffee', 'Short Break',
            () => daemon.call('pomodoro', 'StartPhase', 'short_break'), 'isle-chip-break');
        this._play = iconButton('media-playback-start-symbolic', 'isle-play-pill', () => this._toggle(),
            {size: 16, accessibleName: 'Start or pause'});
        this._focus = chipButton('isle-target', 'Focus Time',
            () => daemon.call('pomodoro', 'StartPhase', 'focus'), 'isle-chip-focus');
        buttons.add_child(this._shortBreak);
        buttons.add_child(this._play);
        buttons.add_child(this._focus);
        center.add_child(buttons);
        this.add_child(center);

        this.watch(['pomodoro'], () => this._update());
        this._update();
    }

    get headerTitle() {
        return 'Pomodoro';
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
        const state = this.daemon.state.pomodoro;
        if (!state)
            return;
        const idle = state.phase === 'idle';
        const remaining = this._remaining(state);

        this._ring.color = timerColor(state.phase);
        this._ring.progress = idle ? 0 : 1 - remaining / state.duration_ms;
        this._time.text = Format.duration(remaining);
        this._caption.text = state.running || idle ? CAPTIONS[state.phase] : `${CAPTIONS[state.phase]} · paused`;

        const sessions = state.today_sessions ?? 0;
        this._stats.visible = sessions > 0;
        this._stats.text = `Today · ${sessions} ${sessions === 1 ? 'session' : 'sessions'} · ${Format.hoursMinutes(state.today_focus_ms ?? 0)}`;

        setButtonIcon(this._play, state.running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic');
        // The stopwatch fills in while running; reset only acts once started.
        this._clock.gicon = icon(state.running ? 'isle-timer-fill' : 'isle-timer');
        setEnabled(this._reset, !idle);

        // The chip of the current phase lights up in its colour and its icon
        // fills in, like Do Not Disturb.
        const onBreak = state.phase === 'short_break' || state.phase === 'long_break';
        const focus = state.phase === 'focus';
        setChip(this._shortBreak, {
            active: onBreak,
            icon: onBreak ? 'isle-coffee-fill' : 'isle-coffee',
            label: state.phase === 'long_break' ? 'Long Break' : 'Short Break',
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
        this.later('tick', (remaining % 1000) + 15, () => this._update());
    }

    onActivate() {
        this._update();
    }
});
