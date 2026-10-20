// Focus timer (Pomodoro): a ring with a stopwatch, the time remaining, and
// chips to jump between a short break and focus. See docs/product-spec.md.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {timerColor} from '../compact.js';
import * as Format from '../format.js';
import {Ring, chipButton, icon, iconButton, label, setButtonIcon, setChip} from '../widgets.js';
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
            style_class: 'pulau-page pulau-timer',
            layout_manager: new Clutter.BoxLayout(),
            height,
        });
        this.name = 'focus';

        // A thin ring that fills clockwise as the phase runs, a clock inside.
        const clock = new St.Icon({gicon: icon('pulau-timer'), icon_size: 28, style_class: 'pulau-focus-icon'});
        this._ring = new Ring({size: 88, lineWidth: 4, trackOpacity: 0.14, child: clock});
        this.add_child(this._ring);

        const center = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'pulau-timer-center'});

        const timeRow = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, style_class: 'pulau-timer-row'});
        this._time = label('25:00', 'pulau-timer-time');
        timeRow.add_child(this._time);
        timeRow.add_child(iconButton('pulau-reset', 'pulau-button-round pulau-button-small',
            () => daemon.call('pomodoro', 'Stop'), {size: 14, accessibleName: 'Reset the timer'}));
        center.add_child(timeRow);

        this._caption = label('', 'pulau-timer-caption', {x_align: Clutter.ActorAlign.CENTER});
        center.add_child(this._caption);

        const buttons = new St.BoxLayout({x_align: Clutter.ActorAlign.CENTER, style_class: 'pulau-timer-buttons'});
        this._shortBreak = chipButton('pulau-coffee', 'Short Break', () => daemon.call('pomodoro', 'StartPhase', 'short_break'));
        this._play = iconButton('media-playback-start-symbolic', 'pulau-play-pill', () => this._toggle(),
            {size: 16, accessibleName: 'Start or pause'});
        this._focus = chipButton('pulau-target', 'Focus Time', () => daemon.call('pomodoro', 'StartPhase', 'focus'));
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

        setButtonIcon(this._play, state.running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic');
        // The chip of the running phase lights up and its icon fills in.
        const shortBreak = state.phase === 'short_break';
        const focus = state.phase === 'focus';
        setChip(this._shortBreak, {active: shortBreak, icon: shortBreak ? 'pulau-coffee-fill' : 'pulau-coffee'});
        setChip(this._focus, {active: focus, icon: focus ? 'pulau-target-fill' : 'pulau-target'});

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
