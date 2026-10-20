// SPDX-License-Identifier: GPL-3.0-or-later

// Turns events into alerts for the peek view (see peek.js for the format).

import * as Format from './format.js';
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

/** Volume, brightness and similar on-screen displays from GNOME. */
export function osd(gicon, text, level, maxLevel) {
    const iconName = gicon?.get_names?.()[0] ?? '';
    const kinds = [
        ['audio-volume', 'Volume'],
        ['microphone', 'Microphone'],
        ['keyboard-brightness', 'Keyboard brightness'],
        ['display-brightness', 'Brightness'],
    ];
    const kind = kinds.find(([prefix]) => iconName.startsWith(prefix))?.[1];
    const hasLevel = typeof level === 'number';
    const fraction = hasLevel ? level / (maxLevel || 1) : null;
    return {
        key: 'osd',
        priority: 'instant',
        transient: true,
        gicon,
        title: kind ?? text ?? '',
        subtitle: kind && text ? text : '',
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
        glyph: '⇪',
        title: on ? 'Caps Lock on' : 'Caps Lock off',
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
            icon: 'isle-timer',
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
        icon: 'isle-timer',
        title: next === 'focus' ? 'Break is over' : Format.phaseName(next),
        subtitle: waiting ? 'Ready for another focus session?' : `${minutes} minutes of focus`,
        tone: 'focus',
        action: waiting ? {label: 'Start focus', callback: () => daemon.call('pomodoro', 'Start')} : null,
        duration: REMINDER_DURATION,
        page: 'focus',
    };
}

export function taskDue(id, title, daemon) {
    return {
        key: `task:${id}`,
        icon: 'isle-tasks',
        title,
        subtitle: 'Due now',
        tone: 'warn',
        action: {label: 'Done', callback: () => daemon.call('todo', 'SetDone', id, true)},
        duration: REMINDER_DURATION,
        page: 'tasks',
    };
}

export function track(nowPlaying) {
    return {
        key: 'track',
        art: nowPlaying.art_path,
        title: nowPlaying.title,
        subtitle: nowPlaying.artist || nowPlaying.identity,
        duration: STATUS_DURATION,
        page: 'music',
    };
}

/** A GNOME notification, shown in place of GNOME's own banner. */
export function notification(item, urgent) {
    // The app or GNOME may withdraw the notification while it is shown;
    // clicking the alert afterwards must not touch the destroyed object.
    let withdrawn = false;
    item.connect('destroy', () => (withdrawn = true));
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
        priority: urgent ? 'instant' : undefined,
        duration: urgent ? REMINDER_DURATION : NOTIFICATION_DURATION,
        page: 'notifications',
        onActivate: () => {
            if (!withdrawn)
                item.activate();
        },
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
