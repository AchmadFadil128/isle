// SPDX-License-Identifier: GPL-3.0-or-later

// Focus: the timer and today's reminders side by side, what to work on beside the time to work on it.
// Each half is its own page (timer.js, tasks.js), shown and hidden with this one.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Page} from './page.js';
import {TasksPage} from './tasks.js';
import {TimerPage} from './timer.js';

export const FocusPage = GObject.registerClass(
class FocusPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-focus',
            layout_manager: new Clutter.BoxLayout(),
            height,
        });
        this.name = 'focus';
        this._timer = new TimerPage(daemon, {height});
        this._tasks = new TasksPage(daemon, {height});
        this._tasks.x_expand = true;
        this.add_child(this._timer);
        this.add_child(new St.Widget({style_class: 'isle-focus-divider', y_align: Clutter.ActorAlign.CENTER}));
        this.add_child(this._tasks);
        for (const half of [this._timer, this._tasks])
            half.connect('request-keyboard', (_half, wanted) => this.emit('request-keyboard', wanted));
    }

    get relevant() {
        return this._timer.relevant;
    }

    onActivate() {
        this._timer.setActive(true);
        this._tasks.setActive(true);
    }

    onDeactivate() {
        this._timer.setActive(false);
        this._tasks.setActive(false);
    }
});
