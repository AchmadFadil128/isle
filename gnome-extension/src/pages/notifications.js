// SPDX-License-Identifier: GPL-3.0-or-later

// Notifications: the count, Do Not Disturb and Clear All on the left, the
// notifications on the right. Click one to open it. See docs/product-spec.md.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Format from '../format.js';
import {notificationIcon, plainBody} from '../notifications.js';
import {chipButton, iconButton, isSymbolic, label, setChip} from '../widgets.js';
import {Page} from './page.js';

/**
 * The app's icon: a colour app icon as it is, a symbolic one on a grey
 * rounded square, the way macOS shows system notifications.
 */
function notificationBadge(gicon) {
    gicon ??= new Gio.ThemedIcon({name: 'dialog-information-symbolic'});
    if (!isSymbolic(gicon))
        return new St.Icon({gicon, icon_size: 32, y_align: Clutter.ActorAlign.CENTER});
    return new St.Bin({
        style_class: 'isle-notification-glyph',
        child: new St.Icon({gicon, icon_size: 18}),
        y_align: Clutter.ActorAlign.CENTER,
    });
}

export const NotificationsPage = GObject.registerClass(
class NotificationsPage extends Page {
    _init(daemon, center, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-notifications',
            layout_manager: new Clutter.BoxLayout(),
            height,
        });
        this.name = 'notifications';
        this._center = center;

        this.add_child(this._buildSummary());
        this.add_child(this._buildList());

        this._centerHandlers = [
            center.connect('changed', () => {
                this._update();
                this.emit('news-changed');
            }),
            center.connect('dnd-changed', () => this._updateDnd()),
        ];
        this._update();
        this._updateDnd();
        this.connect('destroy', () => this._onDestroy());
    }

    get relevant() {
        return this._center.unseenCount > 0;
    }

    get hasNews() {
        return this._center.unseenCount > 0;
    }

    _buildSummary() {
        const side = new St.BoxLayout({vertical: true, style_class: 'isle-notifications-side', y_align: Clutter.ActorAlign.CENTER});
        this._count = label('0', 'isle-tasks-count');
        this._caption = label('', 'isle-tasks-caption');
        side.add_child(this._count);
        side.add_child(this._caption);

        const buttons = new St.BoxLayout({vertical: true, style_class: 'isle-notifications-buttons', x_align: Clutter.ActorAlign.START});
        this._dndButton = chipButton('isle-bell', 'Do Not Disturb', () => {
            this._center.dnd = !this._center.dnd;
        }, 'isle-chip-dnd');
        this._clearButton = chipButton('isle-trash', 'Clear All', () => this._center.clearAll());
        for (const button of [this._dndButton, this._clearButton]) {
            button.x_align = Clutter.ActorAlign.START;
            buttons.add_child(button);
        }
        side.add_child(buttons);
        return side;
    }

    _buildList() {
        this._list = new St.BoxLayout({vertical: true, style_class: 'isle-notification-list'});
        this._scroll = new St.ScrollView({
            style_class: 'isle-task-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad; no scrollbar over the cards.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._list);

        this._empty = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._empty.add_child(label('No notifications', 'isle-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
        this._empty.add_child(label('You’re all caught up', 'isle-empty-hint', {x_align: Clutter.ActorAlign.CENTER}));

        const column = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        column.add_child(this._scroll);
        column.add_child(this._empty);
        return column;
    }

    _update() {
        const notifications = this._center.notifications;
        this._count.text = String(notifications.length);
        this._caption.text = notifications.length === 1 ? 'Notification' : 'Notifications';
        setChip(this._clearButton, {enabled: notifications.some(n => !n.resident)});

        this._list.destroy_all_children();
        for (const notification of notifications)
            this._list.add_child(this._row(notification));
        this._empty.visible = notifications.length === 0;
        this._scroll.visible = notifications.length > 0;

        // Seen while open: no unread dot for something already on screen.
        if (this.active)
            this._center.acknowledgeAll();
    }

    _updateDnd() {
        const on = this._center.dnd;
        setChip(this._dndButton, {active: on, icon: on ? 'isle-moon' : 'isle-bell'});
    }

    /**
     * A card like macOS's: the app's icon, the title with its time on the
     * right (a close button in its place under the pointer), the text below.
     */
    _row(notification) {
        const content = new St.BoxLayout({style_class: 'isle-notification', x_expand: true});
        content.add_child(notificationBadge(notificationIcon(notification)));

        const texts = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const header = new St.BoxLayout({style_class: 'isle-notification-header'});
        const title = label(notification.title || notification.source?.title || '', 'isle-notification-title', {x_expand: true});
        const body = label(plainBody(notification).replace(/\s+/g, ' ').trim(), 'isle-notification-body');
        for (const text of [title, body])
            text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        body.visible = body.text.length > 0;
        // The time and the close button share one spot.
        const corner = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        const time = label(Format.ago(notification.datetime), 'isle-notification-time', {x_align: Clutter.ActorAlign.END});
        corner.add_child(time);
        header.add_child(title);
        header.add_child(corner);
        texts.add_child(header);
        texts.add_child(body);
        content.add_child(texts);

        const row = new St.Button({style_class: 'isle-notification-row', child: content, x_expand: true, can_focus: true});
        row.connect('clicked', () => {
            notification.activate();
            this.emit('request-close');
        });

        if (!notification.resident) {
            const dismiss = iconButton('isle-close-symbolic', 'isle-button-flat isle-notification-dismiss',
                () => notification.destroy(), {size: 10, accessibleName: 'Dismiss'});
            dismiss.x_align = Clutter.ActorAlign.END;
            dismiss.opacity = 0;
            dismiss.reactive = false;
            corner.add_child(dismiss);
            row.connect('notify::hover', () => {
                dismiss.reactive = row.hover;
                dismiss.ease({opacity: row.hover ? 255 : 0, duration: 120});
                time.ease({opacity: row.hover ? 0 : 255, duration: 120});
            });
        }
        return row;
    }

    onActivate() {
        this._center.acknowledgeAll();
        this._update();
    }

    _onDestroy() {
        this._centerHandlers.forEach(id => this._center.disconnect(id));
    }
});
