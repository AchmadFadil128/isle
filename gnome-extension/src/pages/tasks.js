// SPDX-License-Identifier: GPL-3.0-or-later

// Tasks: a plain to-do list; today's progress on the left, the add field and
// list on the right. See docs/product-spec.md, section 5.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {Ring, icon, iconButton, label} from '../widgets.js';
import {Page} from './page.js';

const RING_SIZE = 70;
/** Unfolded finished tasks scroll into view once laid out. */
const REVEAL_DELAY_MS = 60;

export const TasksPage = GObject.registerClass(
class TasksPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-tasks',
            // St's `spacing` only reaches St.BoxLayout, so it is set here.
            layout_manager: new Clutter.BoxLayout({spacing: 22}),
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

    _tasks() {
        return this.daemon.state.tasks ?? [];
    }

    // Building

    _buildSummary() {
        const side = new St.BoxLayout({...VERTICAL, style_class: 'isle-tasks-side', y_align: Clutter.ActorAlign.CENTER});
        this._count = label('0/0', 'isle-tasks-ring-count');
        this._ring = new Ring({size: RING_SIZE, lineWidth: 5, child: this._count});
        side.add_child(this._ring);

        this._ring.x_align = Clutter.ActorAlign.CENTER;
        const info = new St.BoxLayout({...VERTICAL, x_align: Clutter.ActorAlign.CENTER});
        this._headline = label('', 'isle-tasks-headline', {x_align: Clutter.ActorAlign.CENTER});
        this._caption = label('', 'isle-tasks-caption', {x_align: Clutter.ActorAlign.CENTER});
        for (const line of [this._headline, this._caption]) {
            line.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            info.add_child(line);
        }
        side.add_child(info);
        return side;
    }

    _buildList() {
        const column = new St.BoxLayout({...VERTICAL, style_class: 'isle-tasks-column', x_expand: true, y_expand: true});

        this._entry = new St.Entry({
            style_class: 'isle-entry isle-task-add',
            hint_text: 'Add a task',
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({gicon: icon('isle-plus-symbolic'), icon_size: 14, style_class: 'isle-task-add-icon'}));
        const text = this._entry.clutter_text;
        text.connect('activate', () => this._add());
        // The shell only gets keys on request: ask before the field takes focus, as
        // the grab moves focus itself. Esc or a click outside gives the keyboard back.
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

        this._list = new St.BoxLayout({...VERTICAL, style_class: 'isle-task-list'});
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
        // Open tasks in the order they were added; finished ones last, newest first.
        const open = this._tasks().filter(task => !task.done)
            .sort((a, b) => a.id - b.id);
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
    }

    /** Scrolls the unfolded finished tasks into view. */
    _revealDone() {
        this.later('reveal', REVEAL_DELAY_MS, () => {
            const adjustment = this._scroll.vadjustment;
            adjustment.ease(adjustment.upper - adjustment.page_size, {
                duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
    }

    _updateSummary(open, done) {
        // Finished tasks are cleared at midnight, so every done task is today's.
        const total = open.length + done.length;
        this._count.text = `${done.length}/${total}`;
        const allDone = total > 0 && open.length === 0;
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
    }

    _row(task) {
        const row = new St.BoxLayout({
            style_class: `isle-task${task.done ? ' done' : ''}`,
            reactive: true,
            track_hover: true,
        });

        const check = new St.Button({
            style_class: 'isle-task-check',
            child: new St.Icon({gicon: icon('isle-check-symbolic'), icon_size: 11}),
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

        // × appears while the pointer is on the row.
        const remove = iconButton('isle-close-symbolic', 'isle-button-flat isle-task-remove',
            () => this.daemon.call('todo', 'Remove', task.id), {size: 11, accessibleName: 'Remove task'});
        remove.opacity = 0;
        row.connect('notify::hover', () => remove.ease({opacity: row.hover ? 255 : 0, duration: 120}));
        row.add_child(remove);
        return row;
    }

    /** "Completed · 3", folding the finished tasks in and out. */
    _doneHeader(count) {
        const box = new St.BoxLayout({style_class: 'isle-task-section-box'});
        box.add_child(new St.Icon({gicon: icon(this._showDone ? 'isle-chevron-down-symbolic' : 'isle-chevron-right-symbolic'), icon_size: 12}));
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
            if (this._showDone)
                this._revealDone();
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
