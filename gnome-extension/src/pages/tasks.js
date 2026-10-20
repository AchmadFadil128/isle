// SPDX-License-Identifier: GPL-3.0-or-later

// Tasks: today's progress and Add / Edit on the left, the list on the right.
// Quick-add understands "Call mum @18:30" and "Stretch in 20m".
// See docs/product-spec.md, section 5.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Format from '../format.js';
import {chipButton, icon, iconButton, label, setChip} from '../widgets.js';
import {Page} from './page.js';

/** Due times refresh each minute so "in 5 min" stays honest. */
const DUE_REFRESH_MS = 60000;

export const TasksPage = GObject.registerClass(
class TasksPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-tasks',
            layout_manager: new Clutter.BoxLayout(),
            height,
        });
        this.name = 'tasks';
        this._editing = false;

        this.add_child(this._buildSummary());
        this.add_child(this._buildList());

        this.watch(['tasks'], () => this._update());
        this._update();
    }

    get headerTitle() {
        return 'Todo<span foreground="#34d67a">List</span>';
    }

    get relevant() {
        // Worth opening on when something is due within the hour.
        const soon = Format.nowMs() + 60 * 60 * 1000;
        return (this.daemon.state.tasks ?? []).some(task => !task.done && task.due_at_ms && task.due_at_ms < soon);
    }

    _buildSummary() {
        const side = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'isle-tasks-side', y_expand: true});

        // Summary: "4/5 Task Done Today" with Add and Edit.
        this._summary = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._count = label('0/0', 'isle-tasks-count');
        this._summary.add_child(this._count);
        this._summary.add_child(label('Task Done Today', 'isle-tasks-caption'));
        const buttons = new St.BoxLayout({style_class: 'isle-tasks-buttons'});
        buttons.add_child(chipButton('list-add-symbolic', 'Add Task', () => this._startAdding()));
        this._editButton = chipButton('document-edit-symbolic', 'Edit Task', () => this._toggleEditing());
        buttons.add_child(this._editButton);
        this._summary.add_child(buttons);
        side.add_child(this._summary);

        // Adding: a text field in place of the summary.
        this._adder = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true, visible: false});
        this._entry = new St.Entry({
            style_class: 'isle-entry',
            hint_text: 'New task…',
            can_focus: true,
        });
        this._entry.clutter_text.connect('activate', () => this._add());
        this._entry.clutter_text.connect('key-press-event', (_text, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._stopAdding();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._adder.add_child(this._entry);
        this._adder.add_child(label('Enter to add · “@18:30” or “in 20m” for a reminder · Esc to close', 'isle-tasks-hint'));
        side.add_child(this._adder);
        return side;
    }

    _buildList() {
        this._list = new St.BoxLayout({vertical: true, style_class: 'isle-task-list'});
        this._scroll = new St.ScrollView({
            style_class: 'isle-task-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad; no scrollbar over the cards.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._list);

        this._empty = label('No tasks yet', 'isle-tasks-empty', {x_align: Clutter.ActorAlign.CENTER, x_expand: true});

        const column = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        column.add_child(this._scroll);
        column.add_child(this._empty);
        return column;
    }

    _startAdding() {
        this._summary.hide();
        this._adder.show();
        this.emit('request-keyboard', true);
        this._entry.grab_key_focus();
    }

    _stopAdding() {
        this._entry.text = '';
        this._adder.hide();
        this._summary.show();
        this.emit('request-keyboard', false);
    }

    async _add() {
        const text = this._entry.text.trim();
        if (!text)
            return;
        this._entry.text = '';
        await this.daemon.call('todo', 'Add', text);
    }

    _toggleEditing() {
        this._editing = !this._editing;
        setChip(this._editButton, {
            active: this._editing,
            icon: this._editing ? 'object-select-symbolic' : 'document-edit-symbolic',
            label: this._editing ? 'Done' : 'Edit Task',
        });
        this._update();
    }

    _update() {
        const tasks = [...(this.daemon.state.tasks ?? [])];
        // Open tasks first, soonest due first; finished ones at the bottom.
        tasks.sort((a, b) =>
            (a.done - b.done) ||
            ((a.due_at_ms ?? Infinity) - (b.due_at_ms ?? Infinity)) ||
            (a.id - b.id));

        // Finished tasks are cleared at midnight, so every done task is today's.
        const done = tasks.filter(task => task.done).length;
        this._count.text = `${done}/${tasks.length}`;

        this._list.destroy_all_children();
        for (const task of tasks)
            this._list.add_child(this._row(task));
        this._empty.visible = tasks.length === 0;
        this._scroll.visible = tasks.length > 0;

        if (this.active && tasks.some(task => task.due_at_ms && !task.done))
            this.later('due', DUE_REFRESH_MS, () => this._update());
    }

    _row(task) {
        const row = new St.BoxLayout({style_class: `isle-task${task.done ? ' done' : ''}`});

        const check = new St.Button({
            style_class: 'isle-task-check',
            child: new St.Icon({gicon: icon('object-select-symbolic'), icon_size: 11}),
            checked: task.done,
            accessible_name: task.done ? 'Mark as not done' : 'Mark as done',
            y_align: Clutter.ActorAlign.CENTER,
        });
        check.connect('clicked', () => this.daemon.call('todo', 'SetDone', task.id, !task.done));

        const title = label(task.title, 'isle-task-title', {x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(check);
        row.add_child(title);

        if (task.due_at_ms && !task.done) {
            const overdue = task.due_at_ms < Format.nowMs();
            row.add_child(label(Format.due(task.due_at_ms), `isle-task-due${overdue ? ' overdue' : ''}`));
        }
        if (this._editing) {
            row.add_child(iconButton('window-close-symbolic', 'isle-button-flat isle-task-remove',
                () => this.daemon.call('todo', 'Remove', task.id), {size: 11, accessibleName: 'Remove task'}));
        }
        return row;
    }

    onDeactivate() {
        if (this._adder.visible)
            this._stopAdding();
        if (this._editing)
            this._toggleEditing();
    }
});
