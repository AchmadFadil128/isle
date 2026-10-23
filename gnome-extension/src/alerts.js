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
/** A critical notification stays this long once someone is there to see it. */
const CRITICAL_DURATION = 20000;

/** A battery on its side, like macOS's; the ring around it shows the level. */
function batteryIcon(percent) {
    return percent <= 20 ? 'isle-battery-low-symbolic' : 'isle-battery-symbolic';
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

/** Where a level applies when GNOME names none, so every level alert has two lines, as Volume's "Speakers". */
const OSD_PLACES = {'Brightness': 'Built-in Display', 'Keyboard light': 'Keyboard'};

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
        subtitle: kind && text && text !== kind ? text : hasLevel ? OSD_PLACES[kind] ?? '' : '',
        status: hasLevel ? null : state,
        level: hasLevel ? Math.min(fraction, 1) : null,
        levelText: hasLevel ? percentText(level * 100) : null,
        tone: 'neutral',
        duration: OSD_DURATION,
        // Volume: the speaker's waves follow the level (see VolumeGlyph).
        volume: kind === 'Volume' ? {level: hasLevel ? fraction : 0, muted: iconName.includes('muted')} : undefined,
    };
}

export function capsLock(on) {
    return {
        key: 'keyboard',
        priority: 'instant',
        transient: true,
        icon: 'isle-capslock-symbolic',
        motion: on ? 'rise' : undefined,
        title: 'Caps Lock',
        status: on ? 'On' : 'Off',
        tone: 'neutral',
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
            icon: event.plugged ? 'isle-bolt' : batteryIcon(event.percent),
            motion: event.plugged ? 'pulse' : undefined,
            ringIconSize: event.plugged ? undefined : 14,
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
            icon: batteryIcon(event.percent),
            ringIconSize: 14,
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
            motion: 'pulse',
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
            tone: !event.connected ? 'neutral' : battery !== null && battery < 20 ? 'bad' : 'good',
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
            motion: 'bounce',
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
        motion: 'bounce',
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
/** Each notification's own number, so alerts for different ones never replace each other. */
const numbers = new WeakMap();
let lastNumber = 0;

/** Watches `item` for being withdrawn, once however often it is shown (updates come as the same one). */
function watchWithdrawal(item) {
    if (watched.has(item))
        return;
    watched.add(item);
    const id = item.connect('destroy', () => {
        withdrawn.add(item);
        item.disconnect(id);
    });
}

/** Whether a notification still waits to be seen: not withdrawn, nor read in the list meanwhile. */
function unseen(item) {
    return !withdrawn.has(item) && !item.acknowledged;
}

/** A GNOME notification, shown in place of GNOME's own banner; `onShown` once it is on screen. While the
 * screen is `shared`, only who it is from shows. */
export function notification(item, urgent, onShown, shared = false) {
    // The app or GNOME may withdraw the notification while it is shown;
    // clicking the alert afterwards must not touch the destroyed object.
    watchWithdrawal(item);
    if (!numbers.has(item))
        numbers.set(item, ++lastNumber);
    const body = shared ? '' : plainBody(item).replace(/\s+/g, ' ').trim();
    const title = shared ? item.source?.title || 'New notification' : item.title || item.source?.title || '';
    const alert = {
        // Its own key: one arriving behind another waits its turn; the same one updated replaces itself.
        key: `notification:${numbers.get(item)}`,
        kind: 'notification',
        // A critical one waits for someone to be there, like GNOME's, which stays until handled.
        sticky: urgent,
        // Its first button ("Mark as read"), as GNOME's banner had it.
        action: !shared && item.actions?.length ? {
            label: item.actions[0].label,
            callback: () => {
                if (!withdrawn.has(item))
                    item.actions[0]?.activate();
            },
        } : undefined,
        onShown: () => {
            if (!withdrawn.has(item))
                onShown();
        },
        appIcon: true,
        gicon: notificationIcon(item),
        icon: 'dialog-information-symbolic',
        title,
        subtitle: body,
        // A critical one stands out in red.
        tone: urgent ? 'bad' : 'neutral',
        priority: urgent ? 'instant' : undefined,
        duration: urgent ? CRITICAL_DURATION : NOTIFICATION_DURATION,
        page: 'notifications',
        onActivate: () => {
            if (!withdrawn.has(item))
                item.activate();
        },
        item,
        // When its turn comes: gone if withdrawn or read meanwhile, and as the screen is shared now.
        fresh: sharedNow => {
            if (withdrawn.has(item) || (item.acknowledged && !alert.shown))
                return null;
            if (sharedNow === shared)
                return alert;
            const redone = notification(item, urgent, onShown, sharedNow);
            redone.shown = alert.shown;
            return redone;
        },
    };
    return alert;
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
    const when = resetsAt - Date.now() < 20 * 3600e3 ? Format.timeOfDay(at) : `${at.format('%a')} ${Format.timeOfDay(at)}`;
    const name = provider.toLowerCase();
    return {
        key: `usage:${provider}:${window}`,
        icon: name.includes('claude') ? 'isle-claude' : name.includes('gpt') || name.includes('codex') ? 'isle-openai' : 'isle-gauge',
        ring: Math.min(1, percent / 100),
        title: provider,
        subtitle: resetsAt > 0 ? `${limitName(window)} · resets ${when}` : limitName(window),
        value: percentText(percent),
        // In the plan's own colour, as on the Usage page; red once nearly used up.
        tone: percent >= critical ? 'bad' : name.includes('claude') ? 'claude' : name.includes('gpt') || name.includes('codex') ? 'codex' : 'neutral',
        duration: REMINDER_DURATION,
        page: 'usage',
    };
}

/** A reminder the voice assistant set ("remind me in ten minutes to..."). `onShown` once on screen. */
export function reminder({id, text}, onShown) {
    return {
        // Its own key, so reminders due together queue instead of replacing each other.
        key: `reminder:${id}`,
        icon: 'isle-bell',
        motion: 'ring',
        title: text,
        subtitle: 'Reminder',
        tone: 'neutral',
        duration: REMINDER_DURATION,
        // Its time only runs while someone is there to see it.
        sticky: true,
        onShown,
    };
}

/** The meeting service a link goes to, by its host. */
function meetingService(link) {
    const host = (/^https:\/\/([^/]+)/.exec(link)?.[1] ?? '').toLowerCase();
    if (host === 'meet.google.com')
        return 'Google Meet';
    if (host.endsWith('zoom.us'))
        return 'Zoom';
    if (host.startsWith('teams.'))
        return 'Microsoft Teams';
    if (host.endsWith('webex.com'))
        return 'Webex';
    return null;
}

/** An event starts soon ({title, start_ms, end_ms} from the Calendar page); with a meeting `link`, Join opens it. */
export function meeting(event, link, join) {
    const start = new Date(event.start_ms);
    const minutes = Math.max(0, Math.round((event.start_ms - Date.now()) / 60000));
    const at = date => Format.timeOfDay(GLib.DateTime.new_from_unix_local(Math.floor(date.getTime() / 1000)));
    const span = event.end_ms ? `${at(start)} – ${at(new Date(event.end_ms))}` : at(start);
    const service = link ? meetingService(link) : null;
    return {
        key: `meeting:${event.id ?? event.title}:${event.start_ms}`,
        icon: link ? 'isle-video-symbolic' : 'isle-calendar',
        motion: 'bounce',
        title: minutes > 0 ? `${event.title} in ${minutes} min` : `${event.title} now`,
        subtitle: service ? `${span} · ${service}` : span,
        tone: 'calendar',
        duration: REMINDER_DURATION,
        // Its time only runs while someone is there to see it, as a reminder's.
        sticky: true,
        action: link ? {label: 'Join', callback: join} : null,
    };
}

const AGENT_NAMES = {claude: 'Claude', codex: 'Codex'};

/** An AI agent needs the user, or is done ({provider, kind, project, message}); `show` brings its window up. */
export function agent(event, show) {
    const name = AGENT_NAMES[event.provider] ?? 'Your AI';
    const waiting = event.kind === 'permission' || event.kind === 'waiting';
    const title = {permission: `${name} needs your OK`, waiting: `${name} is waiting for you`}[event.kind] ?? `${name} is done`;
    const detail = event.message?.trim();
    return {
        // One per session: a newer word from the same one replaces it.
        key: `agent:${event.provider}:${event.session || event.project}`,
        icon: event.provider === 'codex' ? 'isle-openai' : 'isle-claude',
        motion: waiting ? 'ring' : 'bounce',
        title,
        subtitle: [event.project, detail].filter(Boolean).join(' · '),
        tone: event.provider === 'codex' ? 'codex' : 'claude',
        duration: waiting ? REMINDER_DURATION + 4000 : REMINDER_DURATION,
        // It waits on the user: it stays until they are there to see it.
        sticky: waiting,
        action: show ? {label: 'Show', callback: show} : null,
    };
}

/** A newer Isle is out; `howTo` shows how to update. */
export function update(version, howTo) {
    return {
        key: 'update',
        icon: 'software-update-available-symbolic',
        motion: 'bounce',
        title: `Isle ${version} is out`,
        subtitle: 'Run the install command again to update',
        tone: 'good',
        action: {label: 'How', callback: howTo},
        duration: REMINDER_DURATION,
    };
}

/** isled is not running: the island's music, timer, reminders and assistant wait for it. */
export function serviceDown(restart) {
    return {
        key: 'service-down',
        icon: 'dialog-warning-symbolic',
        motion: 'shake',
        title: 'Isle’s service isn’t running',
        subtitle: 'Music, timer and reminders need it',
        tone: 'bad',
        action: {label: 'Restart', callback: restart},
        duration: REMINDER_DURATION,
    };
}

/** Several notifications (a Set) that came while the island could not show them, summed up. */
export function notificationsSummary(items) {
    const count = items.size;
    const alert = {
        key: 'notifications-summary',
        items,
        icon: 'isle-bell',
        motion: 'bounce',
        title: count === 1 ? '1 new notification' : `${count} new notifications`,
        subtitle: count === 1 ? 'Open the island to read it' : 'Open the island to read them',
        tone: 'neutral',
        duration: NOTIFICATION_DURATION,
        page: 'notifications',
        // One sound for them all (the newest's), as they stay unread; never shown, none plays.
        onShown: () => [...items].filter(unseen).at(-1)?.playSound?.(),
        // Those read or withdrawn meanwhile no longer count.
        fresh: () => {
            const left = new Set([...items].filter(unseen));
            return left.size === count ? alert : left.size ? notificationsSummary(left) : null;
        },
    };
    return alert;
}

/** The voice assistant finished a request the island closed on: its answer, or what went wrong. `open`
 * shows it in full. */
export function assistant(state, open) {
    const failed = state.phase === 'error';
    const text = failed ? state.error || 'Something went wrong' : state.reply || 'Done';
    return {
        key: 'assistant',
        icon: failed ? 'dialog-warning-symbolic' : 'isle-mic-symbolic',
        motion: failed ? 'shake' : 'bounce',
        title: text,
        // An answer may take two lines, as a notification's text does on macOS.
        titleLines: 2,
        subtitle: failed ? state.hint ?? '' : 'Isle Assistant',
        tone: failed ? 'bad' : 'good',
        // Long enough to read, as the open island gives it.
        duration: Math.min(REMINDER_DURATION + 4000, STATUS_DURATION + 45 * text.length),
        onActivate: open,
    };
}

/** GNOME's screen recorder started. */
export function recordingStarted(stop) {
    return {
        key: 'recording',
        icon: 'media-record-symbolic',
        motion: 'pulse',
        title: 'Recording screen',
        subtitle: 'Stop it from the red dot in the island',
        tone: 'bad',
        action: {label: 'Stop', callback: stop},
        duration: STATUS_DURATION,
    };
}
