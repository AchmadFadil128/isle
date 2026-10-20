// SPDX-License-Identifier: GPL-3.0-or-later

// Tasks: today's progress on the left; on the right, a field to add a task
// and the list. Quick-add understands "Call mum @18:30" and "Stretch in 20m".
// Click a title to rename it, a due time to snooze it, × to remove it.
// Finished tasks fold away under "Completed". See docs/product-spec.md,
// section 5.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {timerColor} from '../compact.js';
import * as Format from '../format.js';
import {Ring, icon, iconButton, label} from '../widgets.js';
import {Page} from './page.js';

/** Due times refresh each minute so "in 5 min" stays honest. */
const DUE_REFRESH_MS = 60000;
/** How far clicking a due time pushes it back. */
const SNOOZE_MS = 10 * 60 * 1000;
const RING_SIZE = 64;

export const TasksPage = GObject.registerClass(
class TasksPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-tasks',
            layout_manager: new Clutter.BoxLayout(),
            height,
        });
        this.name = 'tasks';
        /** Whether the finished tasks are unfolded. */
        this._showDone = false;
        /** The task being renamed, if any; the list holds still meanwhile. */
        this._renaming = null;

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
        return this._tasks().some(task => !task.done && task.due_at_ms && task.due_at_ms < soon);
    }

    _tasks() {
        return this.daemon.state.tasks ?? [];
    }

    // Building

    _buildSummary() {
        const side = new St.BoxLayout({style_class: 'isle-tasks-side', y_align: Clutter.ActorAlign.CENTER});
        this._count = label('0/0', 'isle-tasks-ring-count');
        this._ring = new Ring({size: RING_SIZE, lineWidth: 5, child: this._count});
        side.add_child(this._ring);

        const info = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._headline = label('', 'isle-tasks-headline');
        this._caption = label('', 'isle-tasks-caption');
        this._next = label('', 'isle-tasks-next');
        for (const line of [this._headline, this._caption, this._next]) {
            line.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            info.add_child(line);
        }
        side.add_child(info);
        return side;
    }

    _buildList() {
        const column = new St.BoxLayout({vertical: true, style_class: 'isle-tasks-column', x_expand: true, y_expand: true});

        this._entry = new St.Entry({
            style_class: 'isle-entry isle-task-add',
            hint_text: 'Add a task · “Call mum @18:30”',
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({gicon: icon('list-add-symbolic'), icon_size: 14, style_class: 'isle-task-add-icon'}));
        const text = this._entry.clutter_text;
        text.connect('activate', () => this._add());
        // Typing needs the keyboard, which the shell only gets on request.
        // Ask before the field takes focus: the grab moves focus itself.
        // Esc or a click outside the island gives it back.
        text.connect('button-press-event', () => {
            this.emit('request-keyboard', true);
            return Clutter.EVENT_PROPAGATE;
        });
        text.connect('key-press-event', (_text, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._stopAdding();
            return Clutter.EVENT_STOP;
        });
        column.add_child(this._entry);

        this._list = new St.BoxLayout({vertical: true, style_class: 'isle-task-list'});
        this._scroll = new St.ScrollView({
            style_class: 'isle-task-scroll isle-tasks-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad; no scrollbar over the cards.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._list);
        column.add_child(this._scroll);
        return column;
    }

    // Adding

    async _add() {
        const text = this._entry.text.trim();
        if (!text)
            return;
        this._entry.text = '';
        await this.daemon.call('todo', 'Add', text);
    }

    _stopAdding() {
        this._entry.text = '';
        if (this._entry.clutter_text.has_key_focus())
            this.emit('request-keyboard', false);
    }

    // Showing

    _update() {
        if (this._renaming)
            return;
        // Open tasks first, soonest due first; finished ones last, newest first.
        const open = this._tasks().filter(task => !task.done)
            .sort((a, b) => ((a.due_at_ms ?? Infinity) - (b.due_at_ms ?? Infinity)) || (a.id - b.id));
        const done = this._tasks().filter(task => task.done)
            .sort((a, b) => (b.done_at_ms ?? 0) - (a.done_at_ms ?? 0));

        this._updateSummary(open, done);

        this._list.destroy_all_children();
        for (const task of open)
            this._list.add_child(this._row(task));
        if (done.length > 0) {
            this._list.add_child(this._doneHeader(done.length));
            if (this._showDone) {
                for (const task of done)
                    this._list.add_child(this._row(task));
            }
        }
        if (open.length === 0 && done.length === 0)
            this._list.add_child(label('Nothing yet. Type above to add a task.', 'isle-tasks-empty'));

        if (this.active && open.some(task => task.due_at_ms))
            this.later('due', DUE_REFRESH_MS, () => this._update());
    }

    _updateSummary(open, done) {
        // Finished tasks are cleared at midnight, so every done task is today's.
        const total = open.length + done.length;
        this._count.text = `${done.length}/${total}`;
        const allDone = total > 0 && open.length === 0;
        this._ring.color = allDone ? timerColor('short_break') : timerColor('focus');
        this._ring.remove_transition('progress');
        this._ring.ease_property('progress', total ? done.length / total : 0, {
            duration: 400,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        if (total === 0) {
            this._headline.text = 'No tasks yet';
            this._caption.text = 'Plan your day';
        } else if (allDone) {
            this._headline.text = 'All done';
            this._caption.text = `${total} ${total === 1 ? 'task' : 'tasks'} finished today`;
        } else {
            this._headline.text = `${open.length} to go`;
            this._caption.text = `${done.length} of ${total} done today`;
        }
        const next = open.find(task => task.due_at_ms);
        this._next.visible = Boolean(next);
        if (next)
            this._next.text = `Next · ${next.title}`;
    }

    _row(task) {
        const row = new St.BoxLayout({
            style_class: `isle-task${task.done ? ' done' : ''}`,
            reactive: true,
            track_hover: true,
        });

        const check = new St.Button({
            style_class: 'isle-task-check',
            child: new St.Icon({gicon: icon('object-select-symbolic'), icon_size: 11}),
            checked: task.done,
            accessible_name: task.done ? 'Mark as not done' : 'Mark as done',
            y_align: Clutter.ActorAlign.CENTER,
        });
        check.connect('clicked', () => this.daemon.call('todo', 'SetDone', task.id, !task.done));
        row.add_child(check);

        // Click the title to rename the task in place.
        const title = label(task.title, 'isle-task-title', {x_expand: true, reactive: !task.done});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        title.connect('button-release-event', () => {
            this._startRenaming(row, title, task);
            return Clutter.EVENT_STOP;
        });
        row.add_child(title);

        if (task.due_at_ms && !task.done)
            row.add_child(this._dueChip(task));

        // × appears while the pointer is on the row.
        const remove = iconButton('window-close-symbolic', 'isle-button-flat isle-task-remove',
            () => this.daemon.call('todo', 'Remove', task.id), {size: 11, accessibleName: 'Remove task'});
        remove.opacity = 0;
        row.connect('notify::hover', () => remove.ease({opacity: row.hover ? 255 : 0, duration: 120}));
        row.add_child(remove);
        return row;
    }

    /** The due time; clicking it snoozes the task by ten minutes. */
    _dueChip(task) {
        const overdue = task.due_at_ms < Format.nowMs();
        const text = Format.due(task.due_at_ms);
        const chip = new St.Button({
            style_class: `isle-task-due${overdue ? ' overdue' : ''}`,
            label: text,
            accessible_name: `Due ${text}; snooze 10 minutes`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        chip.connect('notify::hover', () => (chip.label = chip.hover ? '+10 min' : text));
        chip.connect('clicked', () => {
            const from = Math.max(Format.nowMs(), task.due_at_ms);
            this.daemon.call('todo', 'SetDue', task.id, from + SNOOZE_MS);
        });
        return chip;
    }

    /** "Completed · 3", folding the finished tasks in and out. */
    _doneHeader(count) {
        const box = new St.BoxLayout({style_class: 'isle-task-section-box'});
        box.add_child(new St.Icon({gicon: icon(this._showDone ? 'pan-down-symbolic' : 'pan-end-symbolic'), icon_size: 12}));
        box.add_child(label(`Completed · ${count}`, 'isle-task-section-label'));
        const header = new St.Button({
            style_class: 'isle-task-section',
            child: box,
            x_align: Clutter.ActorAlign.START,
            accessible_name: this._showDone ? 'Hide completed tasks' : 'Show completed tasks',
        });
        header.connect('clicked', () => {
            this._showDone = !this._showDone;
            this._update();
        });
        return header;
    }

    // Renaming

    _startRenaming(row, title, task) {
        const entry = new St.Entry({style_class: 'isle-entry isle-task-entry', text: task.title, x_expand: true, can_focus: true});
        row.replace_child(title, entry);
        this._renaming = task.id;
        this.emit('request-keyboard', true);
        entry.grab_key_focus();
        entry.clutter_text.set_selection(0, -1);

        let finished = false;
        const finish = save => {
            if (finished)
                return;
            finished = true;
            const text = entry.text.trim();
            this._renaming = null;
            if (save && text && text !== task.title)
                this.daemon.call('todo', 'Rename', task.id, text);
            this.emit('request-keyboard', false);
            this._update();
        };
        entry.clutter_text.connect('activate', () => finish(true));
        // Clicking elsewhere keeps the new name, as in Files.
        entry.clutter_text.connect('key-focus-out', () => finish(true));
        entry.clutter_text.connect('key-press-event', (_text, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            finish(false);
            return Clutter.EVENT_STOP;
        });
    }

    onDeactivate() {
        this._stopAdding();
        this._showDone = false;
    }
});
