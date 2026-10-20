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
import {chipButton, iconButton, label, setChip} from '../widgets.js';
import {Page} from './page.js';

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
            center.connect('changed', () => this._update()),
            center.connect('dnd-changed', () => this._updateDnd()),
        ];
        this._update();
        this._updateDnd();
    }

    get headerTitle() {
        return 'Notifications';
    }

    get relevant() {
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
        this._clearButton = chipButton('edit-clear-all-symbolic', 'Clear All', () => this._center.clearAll());
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

    _row(notification) {
        const content = new St.BoxLayout({style_class: 'isle-notification', x_expand: true});
        content.add_child(new St.Icon({
            gicon: notificationIcon(notification) ?? new Gio.ThemedIcon({name: 'dialog-information-symbolic'}),
            icon_size: 26,
            style_class: 'isle-notification-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const texts = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const title = label(notification.title || notification.source?.title || '', 'isle-notification-title');
        const body = label(plainBody(notification).replace(/\s+/g, ' ').trim(), 'isle-notification-body');
        for (const text of [title, body]) {
            text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            texts.add_child(text);
        }
        body.visible = body.text.length > 0;
        content.add_child(texts);
        content.add_child(label(Format.ago(notification.datetime), 'isle-notification-time'));

        const row = new St.Button({style_class: 'isle-notification-row', child: content, x_expand: true, can_focus: true});
        row.connect('clicked', () => {
            notification.activate();
            this.emit('request-close');
        });

        if (!notification.resident) {
            const dismiss = iconButton('window-close-symbolic', 'isle-button-flat isle-task-remove',
                () => notification.destroy(), {size: 11, accessibleName: 'Dismiss'});
            dismiss.opacity = 0;
            row.connect('notify::hover', () => dismiss.ease({opacity: row.hover ? 255 : 0, duration: 120}));
            content.add_child(dismiss);
        }
        return row;
    }

    onActivate() {
        this._center.acknowledgeAll();
        this._update();
    }

    vfunc_destroy() {
        this._centerHandlers.forEach(id => this._center.disconnect(id));
        super.vfunc_destroy();
    }
});
