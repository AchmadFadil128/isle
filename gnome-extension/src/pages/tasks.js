// SPDX-License-Identifier: GPL-3.0-or-later

// Reminders: the to-do list as macOS shows it. A ticked one is struck through, then goes; finished
// ones are not listed (isled clears them at midnight). See docs/product-spec.md, section 5.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {icon, iconButton, label} from '../widgets.js';
import {Page} from './page.js';

/** How long the line takes to strike a ticked reminder through. */
const STRIKE_MS = 280;
/** A ticked reminder stays this long, struck through, so a second tap can undo it. */
const LINGER_MS = 900;
/** How long it takes to fade and fold away. */
const LEAVE_MS = 260;

export const TasksPage = GObject.registerClass(
class TasksPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-tasks',
            layout_manager: new Clutter.BinLayout(),
            height,
        });
        this.name = 'tasks';
        /** The reminder being renamed, if any; the list holds still meanwhile. */
        this._renaming = null;
        /** Reminders ticked a moment ago, on their way out; the list holds still meanwhile. */
        this._leaving = new Set();
        /** Ticked and gone, until isled reports them done. */
        this._gone = new Set();

        const column = new St.BoxLayout({...VERTICAL, style_class: 'isle-tasks-column', x_expand: true, y_expand: true});
        column.add_child(this._buildAdd());
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
        this._empty = label('No reminders', 'isle-tasks-empty', {
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        column.add_child(this._empty);
        this.add_child(column);

        this.watch(['tasks'], () => this._update());
        this._update();
    }

    _tasks() {
        return this.daemon.state.tasks ?? [];
    }

    // Adding

    _buildAdd() {
        this._entry = new St.Entry({
            style_class: 'isle-entry isle-task-add',
            hint_text: 'Add a reminder…',
            can_focus: true,
            x_expand: true,
        });
        this._entry.set_primary_icon(new St.Icon({gicon: icon('isle-plus-circle-fill'), icon_size: 16, style_class: 'isle-task-add-icon'}));
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
        return this._entry;
    }

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
        if (this._renaming !== null || this._leaving.size > 0)
            return;
        const open = this._tasks().filter(task => !task.done);
        // Forgotten once isled has them done, or gone for another reason.
        this._gone = new Set(open.filter(task => this._gone.has(task.id)).map(task => task.id));
        const shown = open.filter(task => !this._gone.has(task.id)).sort((a, b) => a.id - b.id);

        this._list.destroy_all_children();
        for (const task of shown)
            this._list.add_child(this._row(task));
        this._scroll.visible = shown.length > 0;
        this._empty.visible = shown.length === 0;
    }

    _row(task) {
        const row = new St.BoxLayout({style_class: 'isle-task', reactive: true, track_hover: true});

        const check = new St.Button({
            style_class: 'isle-task-check',
            child: new St.Icon({gicon: icon('isle-check-symbolic'), icon_size: 11}),
            accessible_name: 'Mark as done',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(check);

        // The title, and the line that strikes it through once ticked.
        const titleBox = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const title = label(task.title, 'isle-task-title', {reactive: true, x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        // Click the title to rename it in place.
        title.connect('button-release-event', () => {
            if (!this._leaving.has(task.id))
                this._startRenaming(titleBox, title, task);
            return Clutter.EVENT_STOP;
        });
        // As wide as the box, it grows from the left to the text's width.
        const strike = new St.Widget({style_class: 'isle-task-strike', scale_x: 0, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        strike.set_pivot_point(0, 0.5);
        titleBox.add_child(title);
        titleBox.add_child(strike);
        row.add_child(titleBox);
        check.connect('clicked', () => this._tick(task, {row, check, title, strike}));

        // × appears while the pointer is on the row.
        const remove = iconButton('isle-close-symbolic', 'isle-button-flat isle-task-remove',
            () => this.daemon.call('todo', 'Remove', task.id), {size: 11, accessibleName: 'Delete reminder'});
        remove.opacity = 0;
        row.connect('notify::hover', () => remove.ease({opacity: row.hover ? 255 : 0, duration: 120}));
        row.add_child(remove);
        return row;
    }

    // Ticks a reminder: it is struck through, lingers a moment (a second tap undoes it), then goes.
    _tick(task, {row, check, title, strike}) {
        const name = `leave-${task.id}`;
        if (this._leaving.has(task.id)) {
            this.cancel(name);
            this._leaving.delete(task.id);
            check.checked = false;
            check.accessible_name = 'Mark as done';
            row.remove_style_class_name('done');
            strike.remove_all_transitions();
            strike.ease({scale_x: 0, duration: STRIKE_MS / 2, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            return;
        }
        // The text's own width, as laid out (cut short with … when long); measured before restyling.
        const box = title.get_parent().width;
        const [textWidth] = title.clutter_text.get_layout().get_pixel_size();
        const scale = box > 0 ? Math.min(1, textWidth / box) : 1;
        this._leaving.add(task.id);
        check.checked = true;
        check.accessible_name = 'Not done';
        row.add_style_class_name('done');
        strike.ease({scale_x: scale, duration: STRIKE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this.later(name, LINGER_MS, () => {
            // Folds away: the cards below slide up into its place.
            row.clip_to_allocation = true;
            row.ease({
                opacity: 0,
                height: 0,
                duration: LEAVE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    this._leaving.delete(task.id);
                    this._gone.add(task.id);
                    this.daemon.call('todo', 'SetDone', task.id, true);
                    this._update();
                },
            });
        });
    }

    // Renaming

    _startRenaming(titleBox, title, task) {
        const entry = new St.Entry({style_class: 'isle-entry isle-task-entry', text: task.title, x_expand: true, can_focus: true});
        titleBox.replace_child(title, entry);
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
    }
});
