// SPDX-License-Identifier: GPL-3.0-or-later

// Calendar like macOS's widget: the month, and the chosen day's events from the desktop's
// calendars (GNOME Shell's event source) and Isle's own (isled, removable).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {VERTICAL} from '../compat.js';
import * as Format from '../format.js';
import {icon, iconButton, label} from '../widgets.js';
import {Page} from './page.js';

/** The month grid's height, shared by its rows. */
const GRID_HEIGHT = 108;
const MAX_ROW_HEIGHT = 21;
/** Events of the desktop's calendars (blue), and Isle's own (orange), as RGB. */
const SYSTEM_COLOR = [10, 132, 255];
const OWN_COLOR = [255, 159, 10];
/** How strongly an event's pill is tinted in its colour. */
const PILL_ALPHA = 0.18;
const CALENDAR_APP = 'org.gnome.Calendar.desktop';

const DAY_MS = 24 * 60 * 60 * 1000;

/** "2026-10-21" for a local Date. */
function dayKey(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight starting `date`'s day. */
function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** A Date as a GLib.DateTime, to format it the locale's way. */
function dateTime(date) {
    return GLib.DateTime.new_from_unix_local(Math.floor(date.getTime() / 1000));
}

/** "09:30", or "9:30 AM" with a 12-hour clock. */
function timeText(date) {
    return Format.timeOfDay(dateTime(date));
}

export const CalendarPage = GObject.registerClass(
class CalendarPage extends Page {
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-calendar',
            layout_manager: new Clutter.BoxLayout({spacing: 24}),
            height,
        });
        this.name = 'calendar';
        this._today = startOfDay(new Date());
        /** The day whose events are listed. */
        this._selected = this._today;
        /** The first of the month shown. */
        this._month = new Date(this._today.getFullYear(), this._today.getMonth(), 1);
        this._source = null;
        this._sourceChanged = 0;
        /** The day the list shows, to start another day's at the top. */
        this._listedDay = null;

        this.add_child(this._buildMonth());
        this.add_child(this._buildAgenda());

        this.watch(['events'], () => this._refresh());
        this.connect('destroy', () => this._unbindSource());
        this._refresh();
    }

    // Building

    _buildMonth() {
        const column = new St.BoxLayout({...VERTICAL, style_class: 'isle-cal-month', y_align: Clutter.ActorAlign.CENTER});

        // "OCTOBER 2026" in red, like macOS's widget; click it for today.
        const header = new St.BoxLayout({style_class: 'isle-cal-month-header'});
        const title = new St.BoxLayout({style_class: 'isle-cal-month-title-box'});
        this._monthName = label('', 'isle-cal-month-name');
        this._year = label('', 'isle-cal-year');
        title.add_child(this._monthName);
        title.add_child(this._year);
        const titleButton = new St.Button({style_class: 'isle-cal-month-title', child: title, can_focus: true, accessible_name: 'Go to today', x_expand: true, x_align: Clutter.ActorAlign.START});
        titleButton.connect('clicked', () => this._goToToday());
        header.add_child(titleButton);
        header.add_child(iconButton('isle-chevron-left-symbolic', 'isle-button-flat isle-cal-arrow',
            () => this._moveMonth(-1), {size: 11, accessibleName: 'Previous month'}));
        header.add_child(iconButton('isle-chevron-right-symbolic', 'isle-button-flat isle-cal-arrow',
            () => this._moveMonth(1), {size: 11, accessibleName: 'Next month'}));
        column.add_child(header);

        const weekdays = new St.BoxLayout({style_class: 'isle-cal-weekdays'});
        this._weekStart = Shell.util_get_week_start();
        this._weekend = Format.weekendDays(GLib.getenv('LC_ALL') || GLib.getenv('LC_TIME') || GLib.getenv('LANG') || '');
        for (let i = 0; i < 7; i++) {
            // 4 Jan 1970 was a Sunday.
            const day = new Date(1970, 0, 4 + (this._weekStart + i) % 7);
            const letter = dateTime(day).format('%a').slice(0, 1).toUpperCase();
            const weekend = this._weekend.includes(day.getDay());
            weekdays.add_child(label(letter, `isle-cal-weekday${weekend ? ' weekend' : ''}`, {x_align: Clutter.ActorAlign.CENTER}));
        }
        column.add_child(weekdays);

        this._grid = new St.BoxLayout({...VERTICAL, style_class: 'isle-cal-grid', height: GRID_HEIGHT, y_align: Clutter.ActorAlign.START});
        column.add_child(this._grid);
        return column;
    }

    _buildAgenda() {
        const column = new St.BoxLayout({...VERTICAL, style_class: 'isle-cal-agenda', x_expand: true, y_expand: true});

        const header = new St.BoxLayout({style_class: 'isle-cal-day-header'});
        this._dayName = label('', 'isle-cal-day-name', {x_expand: true});
        this._dayName.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        header.add_child(this._dayName);
        this._todayButton = new St.Button({style_class: 'isle-cal-today', label: 'Today', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        this._todayButton.connect('clicked', () => this._goToToday());
        header.add_child(this._todayButton);
        column.add_child(header);

        this._entry = new St.Entry({style_class: 'isle-entry isle-cal-add', can_focus: true, x_expand: true});
        this._entry.set_primary_icon(new St.Icon({gicon: icon('isle-plus-symbolic'), icon_size: 13, style_class: 'isle-task-add-icon'}));
        const text = this._entry.clutter_text;
        text.connect('activate', () => this._add());
        // Typing needs the keyboard, which the shell only gets on request;
        // ask before the field takes focus, as on the Tasks page.
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

        const listArea = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._list = new St.BoxLayout({...VERTICAL, style_class: 'isle-cal-events'});
        this._scroll = new St.ScrollView({
            style_class: 'isle-cal-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad; no scrollbar over the rows.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._list);
        listArea.add_child(this._scroll);
        this._noEvents = new St.BoxLayout({...VERTICAL, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, y_expand: true});
        this._noEvents.add_child(label('No events', 'isle-cal-empty', {x_align: Clutter.ActorAlign.CENTER}));
        // With no calendar account at all, where to add one.
        this._noAccounts = new St.Button({style_class: 'isle-cal-accounts', label: 'Add calendars in Online Accounts',
            can_focus: true, x_align: Clutter.ActorAlign.CENTER, visible: false});
        this._noAccounts.connect('clicked', () => {
            GLib.spawn_async(null, ['gnome-control-center', 'online-accounts'], null, GLib.SpawnFlags.SEARCH_PATH, null);
            this.emit('request-close');
        });
        this._noEvents.add_child(this._noAccounts);
        listArea.add_child(this._noEvents);
        column.add_child(listArea);
        return column;
    }

    // The desktop's calendars

    /** GNOME Shell's event source; looked up afresh, as it is replaced at the lock screen. */
    _bindSource() {
        const source = Main.panel.statusArea.dateMenu?._eventSource ?? null;
        if (source === this._source)
            return;
        this._unbindSource();
        this._source = source;
        if (source)
            this._sourceChanged = source.connect('changed', () => {
                this._refresh();
                this.markCold();
            });
    }

    _unbindSource() {
        if (this._sourceChanged)
            this._source.disconnect(this._sourceChanged);
        this._sourceChanged = 0;
        this._source = null;
    }

    /** The desktop's events overlapping [begin, end). */
    _systemEvents(begin, end) {
        try {
            return this._source?.getEvents(begin, end) ?? [];
        } catch (e) {
            console.warn(`Isle: could not read calendar events: ${e.message}`);
            return [];
        }
    }

    // Events of a day, from both places

    /** `{title, start, end, allDay, color, ownId}` for each event on `day`, by time. */
    _eventsOn(day) {
        const begin = startOfDay(day);
        const end = addDays(begin, 1);
        const events = this._systemEvents(begin, end).map(event => ({
            title: event.summary || 'Untitled',
            start: event.date,
            end: event.end,
            allDay: event.date <= begin && event.end >= end,
            color: SYSTEM_COLOR,
            ownId: null,
        }));
        const key = dayKey(day);
        for (const event of this.daemon.state.events ?? []) {
            if (event.date !== key)
                continue;
            const at = time => {
                const [hours, minutes] = time.split(':').map(Number);
                return new Date(begin.getFullYear(), begin.getMonth(), begin.getDate(), hours, minutes);
            };
            events.push({
                title: event.title,
                start: event.start ? at(event.start) : begin,
                end: event.end ? at(event.end) : null,
                allDay: !event.start,
                color: OWN_COLOR,
                ownId: event.id,
            });
        }
        // All-day events first, then by start time.
        return events.sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start));
    }

    /** The days of the month shown that have events, as day numbers. */
    _busyDays() {
        const begin = this._month;
        const end = new Date(begin.getFullYear(), begin.getMonth() + 1, 1);
        const busy = new Set();
        for (const event of this._systemEvents(begin, end)) {
            // Each day the event touches, within the month.
            for (let day = startOfDay(event.date < begin ? begin : event.date);
                day < end && day < event.end; day = addDays(day, 1))
                busy.add(day.getDate());
        }
        const prefix = dayKey(begin).slice(0, 8);
        for (const event of this.daemon.state.events ?? []) {
            if (event.date.startsWith(prefix))
                busy.add(Number(event.date.slice(8)));
        }
        return busy;
    }

    // Showing

    /** Draws the month ahead, so the first time the page opens costs no frames. */
    warmUp() {
        this._bindSource();
        this._requestMonth();
        this._refresh(true);
    }

    _refresh(force = false) {
        if (!this.active && !force)
            return; // drawn when the page opens
        this._today = startOfDay(new Date());
        // Redrawn only when what it shows changed: opening the page, or the desktop's calendars
        // answering again with the same events, must not rebuild it while it slides in.
        const now = new Date();
        const shown = JSON.stringify([
            this._today.getTime(), this._month.getTime(), this._selected.getTime(), [...this._busyDays()],
            this._eventsOn(this._selected).map(e => [e.title, +e.start, +e.end, e.allDay, e.ownId,
                !e.allDay && (e.end ?? e.start) < now]),
        ]);
        if (shown === this._shown)
            return;
        this._shown = shown;
        this._renderMonth();
        this._renderAgenda();
    }

    _renderMonth() {
        const month = this._month;
        const now = GLib.DateTime.new_local(month.getFullYear(), month.getMonth() + 1, 1, 0, 0, 0);
        this._monthName.text = now.format('%B').toUpperCase();
        this._year.text = String(month.getFullYear());

        const busy = this._busyDays();
        const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
        const lead = (month.getDay() - this._weekStart + 7) % 7;
        const rows = Math.ceil((lead + daysInMonth) / 7);
        const rowHeight = Math.min(MAX_ROW_HEIGHT, Math.floor(GRID_HEIGHT / rows));

        this._grid.destroy_all_children();
        for (let row = 0; row < rows; row++) {
            const week = new St.BoxLayout({style_class: 'isle-cal-week', height: rowHeight});
            for (let column = 0; column < 7; column++) {
                const number = row * 7 + column - lead + 1;
                week.add_child(number >= 1 && number <= daysInMonth
                    ? this._dayCell(new Date(month.getFullYear(), month.getMonth(), number), busy.has(number))
                    : new St.Widget({style_class: 'isle-cal-cell'}));
            }
            this._grid.add_child(week);
        }
    }

    _dayCell(day, busy) {
        const today = day.getTime() === this._today.getTime();
        const selected = day.getTime() === this._selected.getTime();
        const weekend = this._weekend.includes(day.getDay());
        const classes = ['isle-cal-day'];
        if (today)
            classes.push('today');
        else if (selected)
            classes.push('selected');
        else if (weekend)
            classes.push('weekend');

        const cell = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'isle-cal-cell'});
        const button = new St.Button({
            style_class: classes.join(' '),
            label: String(day.getDate()),
            can_focus: true,
            accessible_name: dateTime(day).format('%A %-d %B'),
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', () => this._select(day));
        cell.add_child(button);
        if (busy) {
            // Under the number, in the circle's bottom edge.
            cell.add_child(new St.Widget({
                style_class: `isle-cal-dot${today ? ' on-today' : ''}`,
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.END,
            }));
        }
        return cell;
    }

    _renderAgenda() {
        const day = this._selected;
        const offset = Math.round((day - this._today) / DAY_MS);
        const name = {'-1': 'Yesterday', 0: 'Today', 1: 'Tomorrow'}[offset] ?? dateTime(day).format('%A');
        this._dayName.text = `${name}, ${dateTime(day).format('%-d %B')}`;
        this._todayButton.visible = offset !== 0 || this._month.getMonth() !== this._today.getMonth() ||
            this._month.getFullYear() !== this._today.getFullYear();
        this._entry.hint_text = 'Add event · e.g. Dinner 8:00 pm';

        this._list.destroy_all_children();
        // Another day's list starts at its top.
        if (day.getTime() !== this._listedDay?.getTime())
            this._scroll.vadjustment.value = 0;
        this._listedDay = day;
        const events = this._eventsOn(day);
        const now = new Date();
        for (const event of events)
            this._list.add_child(this._eventRow(event, now));
        this._noEvents.visible = events.length === 0;
        this._noAccounts.visible = this._source?.hasCalendars === false;
        this._scroll.visible = events.length > 0;
    }

    _eventRow(event, now) {
        const row = new St.BoxLayout({style_class: 'isle-cal-event', reactive: true, track_hover: true});
        const [r, g, b] = event.color;
        row.style = `background-color: rgba(${r}, ${g}, ${b}, ${PILL_ALPHA});`;
        // Finished ones recede.
        const over = !event.allDay && (event.end ?? event.start) < now;
        if (over)
            row.opacity = 130;

        row.add_child(new St.Widget({style_class: 'isle-cal-event-bar', style: `background-color: rgb(${r}, ${g}, ${b});`, y_expand: true}));
        const title = label(event.title, 'isle-cal-event-title', {x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(title);

        let when = 'All day';
        if (!event.allDay) {
            // An event that began on an earlier day shows when it ends.
            const startsToday = event.start >= startOfDay(this._selected);
            when = startsToday ? timeText(event.start) : `until ${timeText(event.end)}`;
            if (startsToday && event.end && event.end > event.start && event.end - startOfDay(this._selected) < DAY_MS)
                when += ` – ${timeText(event.end)}`;
        }
        row.add_child(label(when, 'isle-cal-event-time'));

        if (event.ownId !== null) {
            // × while the pointer is on the row, as on the Tasks page.
            const remove = iconButton('isle-close-symbolic', 'isle-button-flat isle-task-remove',
                () => this.daemon.call('calendar', 'Remove', event.ownId), {size: 10, accessibleName: 'Remove event'});
            remove.opacity = 0;
            row.connect('notify::hover', () => remove.ease({opacity: row.hover ? 255 : 0, duration: 120}));
            row.add_child(remove);
        } else {
            row.connect('button-release-event', () => {
                this._openCalendarApp();
                return Clutter.EVENT_STOP;
            });
        }
        return row;
    }

    // Doing

    _select(day) {
        this._selected = day;
        if (day.getMonth() !== this._month.getMonth() || day.getFullYear() !== this._month.getFullYear())
            this._month = new Date(day.getFullYear(), day.getMonth(), 1);
        this._requestMonth();
        this._refresh();
    }

    _moveMonth(step) {
        this._month = new Date(this._month.getFullYear(), this._month.getMonth() + step, 1);
        this._requestMonth();
        this._refresh();
    }

    _goToToday() {
        this._select(startOfDay(new Date()));
    }

    /** Asks the desktop's calendars for the month shown; they answer with `changed`. */
    _requestMonth() {
        const begin = this._month;
        try {
            this._source?.requestRange(begin, new Date(begin.getFullYear(), begin.getMonth() + 1, 1));
        } catch (e) {
            console.warn(`Isle: could not ask for calendar events: ${e.message}`);
        }
    }

    async _add() {
        const text = this._entry.text.trim();
        if (!text)
            return;
        const result = await this.daemon.call('calendar', 'Add', dayKey(this._selected), text);
        // Kept for another try if it was refused (say, a time alone).
        if (result && !this._destroyed)
            this._entry.text = '';
    }

    _stopAdding() {
        this._entry.text = '';
        if (this._entry.clutter_text.has_key_focus())
            this.emit('request-keyboard', false);
    }

    /** GNOME Calendar, else whatever app opens calendar files. */
    _openCalendarApp() {
        const app = Shell.AppSystem.get_default().lookup_app(CALENDAR_APP);
        if (app) {
            app.activate();
        } else {
            const other = Gio.AppInfo.get_default_for_type('text/calendar', false);
            if (!other)
                return;
            other.launch([], global.create_app_launch_context(0, -1));
        }
        this.emit('request-close');
    }

    /** Redraws at midnight, so "today" moves on. */
    _scheduleMidnight() {
        const now = new Date();
        this.later('midnight', addDays(startOfDay(now), 1) - now + 1000, () => {
            // Following today unless another day was picked.
            if (this._selected.getTime() === this._today.getTime())
                this._goToToday();
            else
                this._refresh();
            this._scheduleMidnight();
        });
    }

    onActivate() {
        this._bindSource();
        // A new day since: back to today, unless another day was picked.
        const today = startOfDay(new Date());
        if (today.getTime() !== this._today.getTime() && this._selected.getTime() === this._today.getTime()) {
            this._goToToday();
        } else {
            this._requestMonth();
            this._refresh();
        }
        this._scheduleMidnight();
    }

    onDeactivate() {
        this._stopAdding();
    }
});
