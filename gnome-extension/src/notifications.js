// SPDX-License-Identifier: GPL-3.0-or-later

// GNOME's notifications via the island, which replaces the clock where GNOME shows them. Hides GNOME's
// banners and emits `banner` by GNOME's rules; Do Not Disturb is GNOME's own "show banners" setting.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

/** Signals: `changed` (): the list or unseen set changed; `banner` (notification): to show, then acknowledge
 * once shown; `dnd-changed` (). */
export class NotificationCenter extends Signals.EventEmitter {
    /** `isleSettings` says whether GNOME keeps its own banners (`gnome-banners`). */
    constructor(isleSettings) {
        super();
        this._tray = Main.messageTray;
        this._sources = new Map();

        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._settingsChanged = this._settings.connect('changed::show-banners', () => this.emit('dnd-changed'));

        this._isleSettings = isleSettings;
        this._bannersChanged = isleSettings.connect('changed::gnome-banners', () => this._syncBanners());
        this._syncBanners();

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

    /** Whether GNOME shows its own banners (as the user chose); else the island does. */
    get _gnomeBanners() {
        return this._isleSettings.get_boolean('gnome-banners');
    }

    _syncBanners() {
        if (this._gnomeBanners && this._blocking)
            this._unblockBanners();
        else if (!this._gnomeBanners && !this._blocking)
            this._blockBanners();
    }

    // GNOME's banners are hidden by keeping the tray's `bannerBlocked` set. The calendar and overview set
    // it too, so their requests are remembered and applied again when the extension stops.
    _blockBanners() {
        this._blocking = true;
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
        this._blocking = false;
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
        if (this._gnomeBanners || notification.acknowledged || notification.urgency === MessageTray.Urgency.LOW)
            return;
        const critical = notification.urgency === MessageTray.Urgency.CRITICAL;
        if (!critical && !notification.source.policy.showBanners)
            return;
        notification.playSound();
        this.emit('banner', notification);
    }

    /** Marks `notification` seen, once it was actually shown (see `banner`). */
    acknowledge(notification) {
        if (notification.acknowledged)
            return;
        notification.acknowledged = true;
        this.emit('changed');
    }

    destroy() {
        // Tell no one about changes made while tearing down.
        this.disconnectAll();
        this._tray.disconnect(this._sourceAdded);
        this._tray.disconnect(this._sourceRemoved);
        for (const source of [...this._sources.keys()])
            this._unwatch(source);
        this._settings.disconnect(this._settingsChanged);
        this._isleSettings.disconnect(this._bannersChanged);
        if (this._blocking)
            this._unblockBanners();
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
