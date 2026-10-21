// SPDX-License-Identifier: GPL-3.0-or-later

// Reminders, as macOS shows them: an orange title and count, plain rows under hairlines, and a
// "New Reminder" row last. A ticked one is struck through, then goes; isled clears it at midnight.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {iconButton, label} from '../widgets.js';
import {Page} from './page.js';

/** How long the tick box takes to fill. */
const FILL_MS = 180;
/** A ticked reminder stays this long, struck through, so a second tap can undo it. */
const LINGER_MS = 900;
/** How long it takes to fade and fold away. */
const LEAVE_MS = 260;

export const TasksPage = GObject.registerClass(
class TasksPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-reminders',
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

        const column = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true});
        column.add_child(this._buildHeader());
        this._list = new St.BoxLayout({...VERTICAL, style_class: 'isle-reminder-list'});
        this._scroll = new St.ScrollView({
            style_class: 'isle-reminder-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad; no scrollbar over the list.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._list);
        column.add_child(this._scroll);
        this.add_child(column);

        this._newRow = this._buildNewRow();
        this.watch(['tasks'], () => this._update());
        this._update();
    }

    _tasks() {
        return this.daemon.state.tasks ?? [];
    }

    // Building

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'isle-reminders-header'});
        header.add_child(label('Reminders', 'isle-reminders-title', {x_expand: true}));
        this._count = label('', 'isle-reminders-count');
        header.add_child(this._count);
        header.add_child(iconButton('isle-plus-symbolic', 'isle-button-flat isle-reminders-add',
            () => this._focusNew(), {size: 14, accessibleName: 'New reminder'}));
        return header;
    }

    // The last row: a faint tick box and a field, where typing a title and Enter adds it.
    _buildNewRow() {
        const row = new St.BoxLayout({style_class: 'isle-reminder isle-reminder-new-row'});
        row.add_child(new St.Widget({style_class: 'isle-reminder-check isle-reminder-check-faint', y_align: Clutter.ActorAlign.CENTER}));
        const content = new St.BoxLayout({style_class: 'isle-reminder-content', x_expand: true});
        this._entry = new St.Entry({style_class: 'isle-reminder-field', hint_text: 'New Reminder', can_focus: true, x_expand: true});
        content.add_child(this._entry);
        row.add_child(content);

        const text = this._entry.clutter_text;
        // Enter adds it and leaves the field ready for the next, as on macOS.
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
        return row;
    }

    _focusNew() {
        this.emit('request-keyboard', true);
        this._entry.grab_key_focus();
        this.later('reveal-new', 30, () => {
            const adjustment = this._scroll.vadjustment;
            adjustment.ease(adjustment.upper - adjustment.page_size, {duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
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
        this._count.text = String(shown.length);

        // The field stays (with what is typed in it) while the rows around it are rebuilt.
        this._list.remove_child(this._newRow);
        this._list.destroy_all_children();
        for (const task of shown)
            this._list.add_child(this._row(task));
        this._list.add_child(this._newRow);
    }

    _row(task) {
        const row = new St.BoxLayout({style_class: 'isle-reminder', reactive: true, track_hover: true});

        // The tick box: a ring, and a dot that pops in when ticked.
        const dot = new St.Widget({style_class: 'isle-reminder-dot', scale_x: 0, scale_y: 0, x_expand: true, y_expand: true});
        dot.set_pivot_point(0.5, 0.5);
        const check = new St.Button({
            style_class: 'isle-reminder-check',
            child: dot,
            accessible_name: 'Mark as done',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(check);

        // The title over a hairline, and the line that strikes it through once ticked.
        const content = new St.BoxLayout({style_class: 'isle-reminder-content', x_expand: true});
        const column = new St.BoxLayout({...VERTICAL, x_expand: true});
        column.add_child(content);
        column.add_child(new St.Widget({style_class: 'isle-reminder-line'}));
        const titleBox = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const title = label(task.title, 'isle-reminder-title', {reactive: true, x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        // Click the title to rename it in place.
        title.connect('button-release-event', () => {
            if (!this._leaving.has(task.id))
                this._startRenaming(titleBox, title, task);
            return Clutter.EVENT_STOP;
        });
        // As wide as the box, scaled from the left to the text's width when ticked.
        const strike = new St.Widget({style_class: 'isle-reminder-strike', scale_x: 0, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        strike.set_pivot_point(0, 0.5);
        titleBox.add_child(title);
        titleBox.add_child(strike);
        content.add_child(titleBox);

        // × appears while the pointer is on the row.
        const remove = iconButton('isle-close-symbolic', 'isle-button-flat isle-reminder-remove',
            () => this.daemon.call('todo', 'Remove', task.id), {size: 10, accessibleName: 'Delete reminder'});
        remove.opacity = 0;
        row.connect('notify::hover', () => remove.ease({opacity: row.hover ? 255 : 0, duration: 120}));
        content.add_child(remove);
        row.add_child(column);

        check.connect('clicked', () => this._tick(task, {row, check, dot, title, strike}));
        return row;
    }

    // Ticks a reminder: the box fills, the title is struck through, it lingers a moment (a second
    // tap undoes it), then fades and folds away.
    _tick(task, {row, check, dot, title, strike}) {
        const name = `leave-${task.id}`;
        const ease = (actor, props, duration) => {
            actor.remove_all_transitions();
            actor.ease({...props, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        };
        if (this._leaving.has(task.id)) {
            this.cancel(name);
            this._leaving.delete(task.id);
            check.remove_style_pseudo_class('checked');
            check.accessible_name = 'Mark as done';
            row.remove_style_class_name('done');
            ease(dot, {scale_x: 0, scale_y: 0}, FILL_MS);
            strike.scale_x = 0;
            return;
        }
        // The text's own width, as laid out (cut short with … when long); measured before restyling.
        const box = title.get_parent().width;
        const [textWidth] = title.clutter_text.get_layout().get_pixel_size();
        this._leaving.add(task.id);
        check.add_style_pseudo_class('checked');
        check.accessible_name = 'Not done';
        row.add_style_class_name('done');
        ease(dot, {scale_x: 1, scale_y: 1}, FILL_MS);
        // Struck through at once, as on macOS.
        strike.scale_x = box > 0 ? Math.min(1, textWidth / box) : 1;
        this.later(name, LINGER_MS, () => {
            // Folds away: the rows below slide up into its place.
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
        const entry = new St.Entry({style_class: 'isle-reminder-field', text: task.title, x_expand: true, can_focus: true});
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
