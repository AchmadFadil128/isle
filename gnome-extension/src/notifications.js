// SPDX-License-Identifier: GPL-3.0-or-later

// GNOME's notifications, routed through the island.
//
// The island replaces the top bar clock, and with it the place GNOME shows
// notifications. This module:
//   - keeps GNOME's own banners hidden while the extension runs, and emits
//     `banner` instead, following the same rules GNOME uses;
//   - lists current notifications for the Notifications page;
//   - exposes Do Not Disturb, which is GNOME's own "show banners" setting,
//     so it stays in sync with Quick Settings.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

/**
 * Signals:
 * - `changed` (): the list of notifications, or which are unseen, changed
 * - `banner` (notification): a new notification should be shown
 * - `dnd-changed` (): Do Not Disturb was turned on or off
 */
export class NotificationCenter extends Signals.EventEmitter {
    constructor() {
        super();
        this._tray = Main.messageTray;
        this._sources = new Map();

        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._settingsChanged = this._settings.connect('changed::show-banners', () => this.emit('dnd-changed'));

        this._blockBanners();

        for (const source of this._tray.getSources())
            this._watch(source);
        this._sourceAdded = this._tray.connect('source-added', (_tray, source) => this._watch(source));
        this._sourceRemoved = this._tray.connect('source-removed', (_tray, source) => this._unwatch(source));
    }

    /** All notifications, newest first. */
    get notifications() {
        const all = [...this._sources.keys()].flatMap(source => source.notifications);
        return all.sort((a, b) => b.datetime.compare(a.datetime));
    }

    get unseenCount() {
        return this.notifications.filter(notification => !notification.acknowledged).length;
    }

    get dnd() {
        return !this._settings.get_boolean('show-banners');
    }

    set dnd(on) {
        this._settings.set_boolean('show-banners', !on);
    }

    /** Marks every notification as seen, clearing the unread dot. */
    acknowledgeAll() {
        const unseen = this.notifications.filter(notification => !notification.acknowledged);
        unseen.forEach(notification => (notification.acknowledged = true));
        if (unseen.length)
            this.emit('changed');
    }

    clearAll() {
        // Resident notifications (e.g. a running download) cannot be dismissed.
        for (const notification of this.notifications.filter(n => !n.resident))
            notification.destroy(MessageTray.NotificationDestroyedReason.DISMISSED);
    }

    /**
     * GNOME's banners are hidden by keeping the tray's `bannerBlocked` set.
     * The calendar and the overview set and clear it too, so their requests
     * are remembered and only applied again when the extension stops.
     */
    _blockBanners() {
        const tray = this._tray;
        // The tray only has a setter, so read the field behind it.
        this._requestedBlock = tray._bannerBlocked;
        const center = this;
        Object.defineProperty(tray, 'bannerBlocked', {
            configurable: true,
            get() {
                return center._requestedBlock;
            },
            set(blocked) {
                center._requestedBlock = blocked;
            },
        });
        tray._bannerBlocked = true;
        tray._updateState();
    }

    _unblockBanners() {
        delete this._tray.bannerBlocked;
        this._tray._bannerBlocked = !this._requestedBlock;
        this._tray.bannerBlocked = this._requestedBlock;
    }

    _watch(source) {
        if (this._sources.has(source))
            return;
        const ids = [
            source.connect('notification-added', () => this.emit('changed')),
            source.connect('notification-removed', () => this.emit('changed')),
            source.connect('notification-request-banner', (_source, notification) => this._onBanner(notification)),
        ];
        this._sources.set(source, ids);
        this.emit('changed');
    }

    _unwatch(source) {
        const ids = this._sources.get(source);
        if (!ids)
            return;
        ids.forEach(id => source.disconnect(id));
        this._sources.delete(source);
        this.emit('changed');
    }

    /** The same rules GNOME applies before showing a banner. */
    _onBanner(notification) {
        if (notification.acknowledged || notification.urgency === MessageTray.Urgency.LOW)
            return;
        const critical = notification.urgency === MessageTray.Urgency.CRITICAL;
        if (!critical && !notification.source.policy.showBanners)
            return;
        notification.acknowledged = true;
        notification.playSound();
        this.emit('changed');
        this.emit('banner', notification);
    }

    destroy() {
        this._tray.disconnect(this._sourceAdded);
        this._tray.disconnect(this._sourceRemoved);
        for (const source of [...this._sources.keys()])
            this._unwatch(source);
        this._settings.disconnect(this._settingsChanged);
        this._unblockBanners();
        this.disconnectAll();
    }
}

/** Plain text of a notification body that may contain Pango markup. */
export function plainBody(notification) {
    const body = notification.body ?? '';
    if (!notification.useBodyMarkup)
        return body;
    return body
        .replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/** The notification's icon, falling back to its app's. */
export function notificationIcon(notification) {
    return notification.gicon ?? notification.source?.icon ?? null;
}
