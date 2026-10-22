// SPDX-License-Identifier: GPL-3.0-or-later

// Turns events into alerts for the peek view (see peek.js for the format).

import GLib from 'gi://GLib';

import * as Format from './format.js';
import * as Playback from './playback.js';
import {notificationIcon, plainBody} from './notifications.js';

const OSD_DURATION = 1500;
const STATUS_DURATION = 2600;
const REMINDER_DURATION = 8000;
const NOTIFICATION_DURATION = 5000;

function batteryIcon(percent, plugged) {
    const level = Math.min(100, Math.max(0, Math.round(percent / 10) * 10));
    if (plugged && level === 100)
        return 'battery-level-100-charged-symbolic';
    return `battery-level-${level}${plugged ? '-charging' : ''}-symbolic`;
}

function percentText(value) {
    return `${Math.round(value)}%`;
}

// GNOME's OSD icons by prefix (first match wins): a title, and the state an icon-only toggle shows.
const OSD_KINDS = [
    ['audio-volume', 'Volume'],
    ['microphone-sensitivity-muted', 'Microphone', 'Muted'],
    ['microphone', 'Microphone'],
    ['keyboard-brightness', 'Keyboard light'],
    ['display-brightness', 'Brightness'],
    ['touchpad-disabled', 'Touchpad', 'Off'],
    ['input-touchpad', 'Touchpad', 'On'],
    ['airplane-mode-disabled', 'Airplane mode', 'Off'],
    ['airplane-mode', 'Airplane mode', 'On'],
    ['camera-disabled', 'Camera', 'Off'],
    ['camera', 'Camera', 'On'],
    ['bluetooth-disabled', 'Bluetooth', 'Off'],
    ['bluetooth', 'Bluetooth', 'On'],
    ['network-wireless-disabled', 'Wi-Fi', 'Off'],
    ['video-display', 'Display'],
];

/** "touchpad-disabled-symbolic" → "Touchpad disabled", for OSDs not listed above. */
function iconTitle(iconName) {
    const words = iconName.replace(/-symbolic$/, '').replace(/-/g, ' ').trim();
    return words ? words[0].toUpperCase() + words.slice(1) : '';
}

/** Volume, brightness and similar on-screen displays from GNOME. */
export function osd(gicon, text, level, maxLevel) {
    const iconName = gicon?.get_names?.()[0] ?? '';
    const [, kind, state] = OSD_KINDS.find(([prefix]) => iconName.startsWith(prefix)) ?? [];
    const hasLevel = typeof level === 'number';
    const fraction = hasLevel ? level / (maxLevel || 1) : null;
    return {
        key: 'osd',
        priority: 'instant',
        transient: true,
        gicon,
        // Toggles (touchpad, airplane mode...) send only an icon; never show it alone.
        title: kind ?? (text || iconTitle(iconName)),
        subtitle: kind && text && text !== kind ? text : '',
        status: hasLevel ? null : state,
        level: hasLevel ? Math.min(fraction, 1) : null,
        levelText: hasLevel ? percentText(level * 100) : null,
        tone: hasLevel && level > 1 ? 'warn' : 'neutral',
        duration: OSD_DURATION,
    };
}

export function capsLock(on) {
    return {
        key: 'keyboard',
        priority: 'instant',
        transient: true,
        icon: 'isle-capslock-symbolic',
        title: 'Caps Lock',
        status: on ? 'On' : 'Off',
        tone: on ? 'warn' : 'neutral',
        duration: OSD_DURATION,
    };
}

/** A `SystemEvent` from the daemon, or null if it is not worth showing. */
export function system(event) {
    switch (event.kind) {
    // Charging and battery alerts: a ring that sweeps up to the
    // charge level around a bolt, with the percentage large on the right.
    case 'power':
        return {
            key: 'power',
            icon: event.plugged ? 'isle-bolt' : batteryIcon(event.percent, false),
            ring: event.percent / 100,
            title: event.plugged ? 'Charging' : 'On Battery',
            subtitle: event.plugged ? 'Charger connected' : 'Charger disconnected',
            value: percentText(event.percent),
            tone: event.plugged ? 'good' : event.percent <= 20 ? 'bad' : 'neutral',
            duration: STATUS_DURATION,
        };
    case 'battery_low':
        return {
            key: 'power',
            icon: batteryIcon(event.percent, false),
            ring: event.percent / 100,
            title: 'Low Battery',
            subtitle: 'Plug in your charger soon',
            value: percentText(event.percent),
            tone: 'bad',
            duration: REMINDER_DURATION,
        };
    case 'battery_full':
        return {
            key: 'power',
            icon: 'isle-bolt',
            ring: 1,
            title: 'Fully Charged',
            subtitle: 'You can unplug your charger',
            value: '100%',
            tone: 'good',
            duration: STATUS_DURATION,
        };
    case 'network':
        // Only losing the connection is worth a pop-up; connecting is
        // expected (e.g. after every wake from sleep).
        if (event.connected)
            return null;
        return {
            key: 'network',
            icon: 'network-wireless-offline-symbolic',
            title: 'Offline',
            subtitle: 'The network connection was lost',
            tone: 'bad',
            duration: STATUS_DURATION,
        };
    case 'bluetooth': {
        const {device} = event;
        const battery = event.connected ? device.battery ?? null : null;
        return {
            key: `bluetooth:${device.path}`,
            icon: device.icon.endsWith('-symbolic') ? device.icon : `${device.icon}-symbolic`,
            ring: battery !== null ? battery / 100 : null,
            title: device.name,
            subtitle: event.connected ? 'Connected' : 'Disconnected',
            value: battery !== null ? percentText(battery) : null,
            tone: !event.connected ? 'neutral' : battery !== null && battery < 20 ? 'warn' : 'good',
            duration: STATUS_DURATION,
        };
    }
    default:
        return null;
    }
}

export function pomodoroFinished(finished, next, state, daemon) {
    const waiting = !state?.running;
    const minutes = state ? Math.round(state.duration_ms / 60000) : 0;
    if (finished === 'focus') {
        return {
            key: 'pomodoro',
            icon: 'isle-timer-symbolic',
            title: 'Focus session done',
            subtitle: waiting ? 'Take a break when you are ready' : `Enjoy a ${minutes}-minute break`,
            tone: 'good',
            action: waiting ? {label: 'Start break', callback: () => daemon.call('pomodoro', 'Start')} : null,
            duration: REMINDER_DURATION,
            page: 'focus',
        };
    }
    return {
        key: 'pomodoro',
        icon: 'isle-timer-symbolic',
        title: next === 'focus' ? 'Break is over' : Format.phaseName(next),
        subtitle: waiting ? 'Ready for another focus session?' : `${minutes} minutes of focus`,
        tone: 'focus',
        action: waiting ? {label: 'Start focus', callback: () => daemon.call('pomodoro', 'Start')} : null,
        duration: REMINDER_DURATION,
        page: 'focus',
    };
}

export function track(nowPlaying) {
    return {
        key: 'track',
        art: nowPlaying.art_path,
        badge: Playback.playerApp(nowPlaying)?.get_icon() ?? null,
        title: nowPlaying.title,
        subtitle: nowPlaying.artist || nowPlaying.identity,
        duration: STATUS_DURATION,
        page: 'music',
    };
}

/** Notifications already watched, and those since withdrawn (destroyed). */
const watched = new WeakSet();
const withdrawn = new WeakSet();

/** Watches `item` for being withdrawn, once however often it is shown (updates come as the same one). */
function watchWithdrawal(item) {
    if (watched.has(item))
        return;
    watched.add(item);
    item.connect('destroy', () => withdrawn.add(item));
}

/** A GNOME notification, shown in place of GNOME's own banner. */
export function notification(item, urgent) {
    // The app or GNOME may withdraw the notification while it is shown;
    // clicking the alert afterwards must not touch the destroyed object.
    watchWithdrawal(item);
    const body = plainBody(item).replace(/\s+/g, ' ').trim();
    const title = item.title || item.source?.title || '';
    return {
        // A critical one is never replaced by a routine one behind it.
        key: urgent ? 'notification-urgent' : 'notification',
        appIcon: true,
        gicon: notificationIcon(item),
        icon: 'dialog-information-symbolic',
        title,
        subtitle: body,
        // A critical one stands out in red.
        tone: urgent ? 'bad' : 'neutral',
        priority: urgent ? 'instant' : undefined,
        duration: urgent ? REMINDER_DURATION : NOTIFICATION_DURATION,
        page: 'notifications',
        onActivate: () => {
            if (!withdrawn.has(item))
                item.activate();
        },
    };
}

/** "5 hours" → "5-hour limit", "Week · Opus" → "weekly Opus limit". */
function limitName(window) {
    if (window === '5 hours')
        return '5-hour limit';
    const [span, model] = window.split(' · ');
    const kind = span === 'Week' ? 'Weekly' : span;
    return model ? `${kind} ${model} limit` : `${kind} limit`;
}

/** An AI plan limit nears its end: the provider's logo in a ring of the share, "86%" beside it. */
export function usage(provider, window, percent, resetsAt, critical) {
    const at = GLib.DateTime.new_from_unix_local(Math.floor(resetsAt / 1000));
    // Within the next 20 hours (later today or tomorrow morning), the time alone; later, with the day.
    const when = at.format(resetsAt - Date.now() < 20 * 3600e3 ? '%H:%M' : '%a %H:%M');
    const name = provider.toLowerCase();
    return {
        key: `usage:${provider}:${window}`,
        icon: name.includes('claude') ? 'isle-claude' : name.includes('gpt') || name.includes('codex') ? 'isle-openai' : 'isle-gauge',
        ring: Math.min(1, percent / 100),
        title: provider,
        subtitle: resetsAt > 0 ? `${limitName(window)} · resets ${when}` : limitName(window),
        value: percentText(percent),
        tone: percent >= critical ? 'bad' : 'warn',
        duration: REMINDER_DURATION,
        page: 'usage',
    };
}

/** A reminder the voice assistant set ("remind me in ten minutes to..."). */
export function reminder({id, text}) {
    return {
        // Its own key, so reminders due together queue instead of replacing each other.
        key: `reminder:${id}`,
        icon: 'isle-bell',
        title: text,
        subtitle: 'Reminder',
        tone: 'warn',
        duration: REMINDER_DURATION,
    };
}

/** GNOME's screen recorder started. */
export function recordingStarted(stop) {
    return {
        key: 'recording',
        icon: 'media-record-symbolic',
        title: 'Recording screen',
        subtitle: 'Stop it from the red dot in the island',
        tone: 'bad',
        action: {label: 'Stop', callback: stop},
        duration: STATUS_DURATION,
    };
}
