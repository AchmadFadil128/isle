// SPDX-License-Identifier: GPL-3.0-or-later

// Reminders, the right half of the Focus page (focus.js), as macOS's in dark mode: an orange title and
// count, a ring and a hairline per reminder, and a last row to add one; a ticked one is struck, then goes.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {iconButton, label} from '../widgets.js';
import {Page} from './page.js';

/** How long the dot takes to pop into the ring. */
const TICK_MS = 200;
/** A ticked reminder stays this long, struck through, so a second tap can undo it. */
const LINGER_MS = 900;
/** How long it takes to fade and fold away. */
const LEAVE_MS = 260;

export const TasksPage = GObject.registerClass(
class TasksPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-reminders',
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
        this._newRow = this._buildNewRow();
        // Under the new row when there are none: what macOS says.
        this._empty = label('', 'isle-reminders-empty', {x_align: Clutter.ActorAlign.CENTER, y_expand: true});
        const middle = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        middle.add_child(this._scroll);
        middle.add_child(this._empty);
        column.add_child(middle);
        this.add_child(column);

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
            () => this._focusNew(), {size: 12, accessibleName: 'New reminder'}));
        return header;
    }

    // The last row: a faint ring and a field, where typing a title and Enter adds it.
    _buildNewRow() {
        const row = new St.BoxLayout({style_class: 'isle-reminder isle-reminder-new'});
        row.add_child(new St.Widget({style_class: 'isle-reminder-check faint', y_align: Clutter.ActorAlign.CENTER}));
        const column = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true});
        this._entry = new St.Entry({style_class: 'isle-reminder-field', hint_text: 'New Reminder', can_focus: true, x_expand: true});
        const content = new St.BoxLayout({style_class: 'isle-reminder-content', y_expand: true});
        content.add_child(this._entry);
        column.add_child(content);
        row.add_child(column);

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
        this._revealNew();
    }

    _revealNew() {
        this.later('reveal-new', 40, () => {
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
        this._revealNew();
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
        const tasks = this._tasks();
        const open = tasks.filter(task => !task.done);
        // Forgotten once isled has them done, or gone for another reason.
        this._gone = new Set(open.filter(task => this._gone.has(task.id)).map(task => task.id));
        const shown = open.filter(task => !this._gone.has(task.id)).sort((a, b) => a.id - b.id);
        this._count.text = String(shown.length);

        // The field stays in place, with what is typed in it and its focus, while the rows above it are
        // rebuilt: taking it off the stage, even for a moment, would drop the keyboard focus.
        if (!this._newRow.get_parent())
            this._list.add_child(this._newRow);
        // A row's field losing its focus as it is destroyed upsets the input method: let go of it first.
        const focus = global.stage.get_key_focus();
        if (focus && this._list.contains(focus) && !this._newRow.contains(focus))
            global.stage.set_key_focus(null);
        for (const child of this._list.get_children()) {
            if (child !== this._newRow)
                child.destroy();
        }
        for (const task of shown)
            this._list.insert_child_below(this._row(task), this._newRow);
        this._empty.visible = shown.length === 0;
        this._empty.text = tasks.length > shown.length ? 'All Done' : 'No Reminders';
    }

    _row(task) {
        const row = new St.BoxLayout({style_class: 'isle-reminder', reactive: true, track_hover: true});

        // The tick box: a ring, and a dot that pops into it when ticked.
        const dot = new St.Widget({style_class: 'isle-reminder-dot', scale_x: 0, scale_y: 0, x_expand: true, y_expand: true});
        dot.set_pivot_point(0.5, 0.5);
        const check = new St.Button({
            style_class: 'isle-reminder-check',
            child: dot,
            accessible_name: 'Mark as done',
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(check);

        // The title over a hairline that runs from the text to the edge, as on macOS.
        const column = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true});
        const content = new St.BoxLayout({style_class: 'isle-reminder-content', y_expand: true});
        const titleBox = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const title = label(task.title, 'isle-reminder-title', {reactive: true, x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        // Click the title to rename it in place.
        title.connect('button-release-event', () => {
            // One rename at a time: starting another would rebuild the list mid focus change.
            if (this._renaming === null && !this._leaving.has(task.id))
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
            () => this.daemon.call('todo', 'Remove', task.id), {size: 9, accessibleName: 'Delete reminder'});
        remove.opacity = 0;
        row.connect('notify::hover', () => remove.ease({opacity: row.hover ? 255 : 0, duration: 120}));
        content.add_child(remove);
        column.add_child(content);
        column.add_child(new St.Widget({style_class: 'isle-reminder-line'}));
        row.add_child(column);

        check.connect('clicked', () => this._tick(task, {row, check, dot, title, strike}));
        return row;
    }

    // Ticks a reminder: the ring turns orange with a dot in it, the title is struck through, it lingers
    // a moment (a second tap undoes it), then fades and folds away.
    _tick(task, {row, check, dot, title, strike}) {
        // Folding away already: too late to undo.
        if (!check.reactive)
            return;
        const name = `leave-${task.id}`;
        const pop = shown => {
            dot.remove_all_transitions();
            dot.ease({
                scale_x: shown ? 1 : 0,
                scale_y: shown ? 1 : 0,
                duration: TICK_MS,
                mode: shown ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        };
        if (this._leaving.has(task.id)) {
            this.cancel(name);
            this._leaving.delete(task.id);
            check.remove_style_pseudo_class('checked');
            check.accessible_name = 'Mark as done';
            row.remove_style_class_name('done');
            pop(false);
            strike.scale_x = 0;
            return;
        }
        // The text's own width, as laid out (cut short with … when long); measured before restyling.
        // The strike's box, not the title's: the title is off it while being renamed.
        const box = strike.get_parent()?.width ?? 0;
        const [textWidth] = title.clutter_text.get_layout().get_pixel_size();
        this._leaving.add(task.id);
        check.add_style_pseudo_class('checked');
        check.accessible_name = 'Not done';
        row.add_style_class_name('done');
        pop(true);
        // Struck through at once.
        strike.scale_x = box > 0 ? Math.min(1, textWidth / box) : 1;
        this.later(name, LINGER_MS, () => {
            // Folds away: the rows below slide up into its place; too late now to undo.
            check.reactive = false;
            row.clip_to_allocation = true;
            row.ease({
                opacity: 0,
                height: 0,
                duration: LEAVE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    // Already settled by `onDeactivate`, whose rebuild is what stopped this.
                    if (!this._leaving.delete(task.id))
                        return;
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
            if (this._renaming === task.id)
                this._renaming = null;
            if (save && text && text !== task.title)
                this.daemon.call('todo', 'Rename', task.id, text);
            // After this event: it may come as focus moves, and the entry must outlive the move.
            this.later('renamed', 0, () => {
                this._update();
                this._releaseKeyboard();
            });
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

    /** Gives the keyboard back, unless a field here still has it (focus moved from one to another). */
    _releaseKeyboard() {
        const focus = global.stage.get_key_focus();
        if (!focus || !this.contains(focus))
            this.emit('request-keyboard', false);
    }

    onDeactivate() {
        this._stopAdding();
        // Nothing in the middle of anything: the list stays as it is, with no rebuild as the page goes.
        if (this._renaming === null && this._leaving.size === 0)
            return;
        this._renaming = null;
        // Closing cancels the linger: ticked ones are done now, so the list never stays frozen.
        for (const id of this._leaving) {
            this._gone.add(id);
            this.daemon.call('todo', 'SetDone', id, true);
        }
        this._leaving.clear();
        this._update();
    }
});
