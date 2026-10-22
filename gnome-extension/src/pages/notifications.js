// SPDX-License-Identifier: GPL-3.0-or-later

// Notifications: the count, Do Not Disturb and Clear All on the left, the
// notifications on the right. Click one to open it. See docs/product-spec.md.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import * as Format from '../format.js';
import {notificationIcon, plainBody} from '../notifications.js';
import {icon, iconButton, isSymbolic, label, pillButton, setButtonIcon, setEnabled} from '../widgets.js';
import {Page} from './page.js';

/** A card offers at most this many of its notification's buttons ("Mark as read", "Accept"). */
const MAX_ACTIONS = 3;

/** Notifications grouped by app, apps ordered by their newest; newest first within an app. */
function groupByApp(notifications) {
    const groups = new Map();
    for (const notification of notifications) {
        const source = notification.source ?? notification;
        if (!groups.has(source))
            groups.set(source, []);
        groups.get(source).push(notification);
    }
    return groups;
}

/** The app's name for a stack, e.g. "Chrome". */
function appName(source, notification) {
    return source?.title || notification.title || 'this app';
}

/** The app's icon: a colour one as is, a symbolic one on a grey rounded square, as macOS does. */
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
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            height,
        });
        this.name = 'notifications';
        this._center = center;
        /** Apps whose stack of notifications is unfolded. */
        this._openGroups = new Set();

        this.add_child(this._buildBar());
        this.add_child(this._buildList());

        this._centerHandlers = [
            // Closed, the list is only rebuilt when next shown (see `onActivate`).
            center.connect('changed', () => {
                if (this.active)
                    this._update();
                else
                    this._stale = true;
                this.markCold();
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

    /** How many there are, then Do Not Disturb and Clear All as small round buttons. */
    _buildBar() {
        const bar = new St.BoxLayout({style_class: 'isle-notifications-bar'});
        this._count = label('', 'isle-notifications-count', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        bar.add_child(this._count);
        this._dndButton = iconButton('isle-bell', 'isle-button-round isle-button-small isle-dnd-toggle', () => {
            this._center.dnd = !this._center.dnd;
        }, {size: 14, accessibleName: 'Do Not Disturb'});
        this._clearButton = iconButton('isle-trash', 'isle-button-round isle-button-small',
            () => this._center.clearAll(), {size: 14, accessibleName: 'Clear all'});
        bar.add_child(this._dndButton);
        bar.add_child(this._clearButton);
        return bar;
    }

    _buildList() {
        this._list = new St.BoxLayout({...VERTICAL, style_class: 'isle-notification-list'});
        this._scroll = new St.ScrollView({
            style_class: 'isle-task-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad; no scrollbar over the cards.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._list);

        this._empty = new St.BoxLayout({...VERTICAL, style_class: 'isle-empty', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._empty.add_child(new St.Icon({gicon: icon('isle-bell'), icon_size: 24, style_class: 'isle-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
        this._empty.add_child(label('No notifications', 'isle-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
        this._empty.add_child(label('You’re all caught up', 'isle-empty-hint', {x_align: Clutter.ActorAlign.CENTER}));

        const column = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        column.add_child(this._scroll);
        column.add_child(this._empty);
        return column;
    }

    _update() {
        this._stale = false;
        /** Each card's "5m ago", with when it came, to bring up to date without a rebuild. */
        this._times = [];
        const notifications = this._center.notifications;
        const count = notifications.length;
        this._count.text = count ? `${count} ${count === 1 ? 'notification' : 'notifications'}` : '';
        setEnabled(this._clearButton, notifications.some(n => !n.resident));

        this._list.destroy_all_children();
        const groups = groupByApp(notifications);
        // Forget unfolded stacks of apps that have nothing left.
        for (const source of this._openGroups) {
            if (!groups.has(source))
                this._openGroups.delete(source);
        }
        for (const [source, items] of groups) {
            if (items.length === 1)
                this._list.add_child(this._row(items[0]));
            else if (this._openGroups.has(source))
                this._addOpenGroup(source, items);
            else
                this._list.add_child(this._stack(source, items));
        }
        this._empty.visible = notifications.length === 0;
        this._scroll.visible = notifications.length > 0;

        // Seen while open: no unread dot for something already on screen.
        if (this.active)
            this._center.acknowledgeAll();
    }

    /** An app's notifications as a macOS-like stack: newest on top, the next peeking out, "+2 more from …". */
    _stack(source, items) {
        const stack = new St.BoxLayout({...VERTICAL, style_class: 'isle-notification-stack'});
        stack.add_child(this._row(items[0]));
        stack.add_child(new St.Widget({style_class: 'isle-notification-peek', x_expand: true}));
        const more = new St.Button({
            style_class: 'isle-notification-more',
            label: `+${items.length - 1} more from ${appName(source, items[0])}`,
            x_align: Clutter.ActorAlign.START,
            can_focus: true,
        });
        more.connect('clicked', () => {
            this._openGroups.add(source);
            this._update();
        });
        stack.add_child(more);
        return stack;
    }

    /** An unfolded stack: the app's name with "Show less", then each one. */
    _addOpenGroup(source, items) {
        const header = new St.BoxLayout({style_class: 'isle-notification-group-header'});
        header.add_child(label(appName(source, items[0]), 'isle-notification-group-name', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const less = new St.Button({style_class: 'isle-notification-less', label: 'Show less', can_focus: true});
        less.connect('clicked', () => {
            this._openGroups.delete(source);
            this._update();
        });
        header.add_child(less);
        this._list.add_child(header);
        for (const notification of items)
            this._list.add_child(this._row(notification));
    }

    _updateDnd() {
        const on = this._center.dnd;
        if (on)
            this._dndButton.add_style_pseudo_class('checked');
        else
            this._dndButton.remove_style_pseudo_class('checked');
        setButtonIcon(this._dndButton, on ? 'isle-moon' : 'isle-bell');
    }

    /** A macOS-like card: app icon, title with its time (a close button under the pointer), text below. */
    _row(notification) {
        const content = new St.BoxLayout({style_class: 'isle-notification', x_expand: true});
        content.add_child(notificationBadge(notificationIcon(notification)));

        const texts = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const header = new St.BoxLayout({style_class: 'isle-notification-header'});
        const title = label(notification.title || notification.source?.title || '', 'isle-notification-title', {x_expand: true});
        // While the screen is shared, only who wrote, not what.
        const text = this._sharing ? '' : plainBody(notification).replace(/\s+/g, ' ').trim();
        const body = label(text, 'isle-notification-body');
        for (const part of [title, body])
            part.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        body.visible = body.text.length > 0;
        // The time and the close button share one spot.
        const corner = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        const time = label(Format.ago(notification.datetime), 'isle-notification-time', {x_align: Clutter.ActorAlign.END});
        this._times.push([time, notification.datetime]);
        corner.add_child(time);
        header.add_child(title);
        header.add_child(corner);
        texts.add_child(header);
        texts.add_child(body);
        // Its buttons, as GNOME's banner had them; not while the screen is shared.
        const actions = this._sharing ? [] : (notification.actions ?? []).slice(0, MAX_ACTIONS);
        if (actions.length > 0) {
            const buttons = new St.BoxLayout({style_class: 'isle-notification-actions'});
            for (const action of actions) {
                buttons.add_child(pillButton(action.label, 'isle-pill-small isle-notification-action', () => {
                    action.activate();
                    this.emit('request-close');
                }));
            }
            texts.add_child(buttons);
        }
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

    warmUp() {
        if (this._stale)
            this._update();
    }

    /** While the screen is shared or recorded, the cards leave out what the notifications say. */
    set sharing(sharing) {
        if (sharing === Boolean(this._sharing))
            return;
        this._sharing = sharing;
        if (this.active)
            this._update();
        else
            this._stale = true;
        this.markCold();
    }

    onActivate() {
        this._center.acknowledgeAll();
        // Rebuilt only if something came or went while it was closed; else just the times move on.
        if (this._stale)
            this._update();
        else
            this._times.forEach(([time, datetime]) => (time.text = Format.ago(datetime)));
    }

    _onDestroy() {
        this._centerHandlers.forEach(id => this._center.disconnect(id));
    }
});
