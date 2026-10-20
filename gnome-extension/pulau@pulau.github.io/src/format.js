// Text formatting shared by the island's views.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

let interfaceSettings = null;

/** Whether the user prefers a 12-hour clock in GNOME's settings. */
export function uses12Hour() {
    interfaceSettings ??= new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    return interfaceSettings.get_string('clock-format') === '12h';
}

/** "14:05", or "2:05" with a 12-hour clock. */
export function clockTime(dateTime = GLib.DateTime.new_now_local()) {
    return dateTime.format(uses12Hour() ? '%l:%M' : '%H:%M').trim();
}

/** "Tue 20 Oct 2026". */
export function longDate(dateTime = GLib.DateTime.new_now_local()) {
    return dateTime.format('%a %-d %b %Y');
}

/** Formats a duration as "3:07" or "1:02:07". */
export function duration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    const seconds = String(total % 60).padStart(2, '0');
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
        : `${minutes}:${seconds}`;
}

/** "1,250 ml" or "2 L". */
export function volume(ml) {
    if (ml >= 1000 && ml % 1000 === 0)
        return `${ml / 1000} L`;
    return `${ml.toLocaleString('en-US')} ml`;
}

/** A due time relative to now: "in 20 min", "18:30", "Tomorrow 09:00", "Overdue". */
export function due(atMs) {
    const now = Date.now();
    const minutes = Math.round((atMs - now) / 60000);
    if (minutes < 0)
        return 'Overdue';
    if (minutes < 60)
        return minutes <= 1 ? 'Now' : `in ${minutes} min`;
    const at = GLib.DateTime.new_from_unix_local(Math.floor(atMs / 1000));
    const today = GLib.DateTime.new_now_local();
    const time = clockTime(at);
    if (at.get_day_of_year() === today.get_day_of_year() && at.get_year() === today.get_year())
        return time;
    return `${at.format('%a')} ${time}`;
}

/** How long ago a GLib.DateTime was: "now", "5m", "2h", or "Mon". */
export function ago(dateTime) {
    const now = GLib.DateTime.new_now_local();
    const minutes = Math.floor(now.difference(dateTime) / 60e6);
    if (minutes < 1)
        return 'now';
    if (minutes < 60)
        return `${minutes}m`;
    if (minutes < 24 * 60)
        return `${Math.floor(minutes / 60)}h`;
    return dateTime.format('%a');
}

/** Human name for a pomodoro phase. */
export function phaseName(phase) {
    return {
        idle: 'Ready to focus',
        focus: 'Focus',
        short_break: 'Short break',
        long_break: 'Long break',
    }[phase] ?? phase;
}

/** Wall-clock milliseconds, in the same terms as the daemon's timestamps. */
export function nowMs() {
    return Math.floor(GLib.get_real_time() / 1000);
}
