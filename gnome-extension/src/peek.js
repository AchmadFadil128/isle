// SPDX-License-Identifier: GPL-3.0-or-later

// Short-lived alerts the island grows to show. An alert: {key (same key replaces), icon | gicon | art, badge,
// appIcon, ring, title, subtitle, tone, value, status, level, action, duration, onActivate, page, priority, transient}.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from './compat.js';
import {Art, LevelBar, Ring, icon, isSymbolic, pillButton} from './widgets.js';

/** Narrowest and widest an alert gets; in between it fits its content. */
const MIN_WIDTH = 220;
const MAX_WIDTH = 380;
/** Height of the part that hangs below the top bar: a line of text, or two. */
const HEIGHT = {one: 44, two: 52};

/** The ring starts sweeping once the island has made room. */
const RING_DELAY = 350;

const TONE_COLORS = {
    neutral: [1, 1, 1],
    good: [0.2, 0.88, 0.48],
    focus: [0.2, 0.88, 0.48],
    warn: [1, 0.72, 0.2],
    bad: [1, 0.36, 0.36],
    break: [0.35, 0.67, 1],
};

const css = ([r, g, b], alpha = 1) =>
    `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;

/** The badge behind an icon, lit from the top in the alert's colour like iOS's; grey when neutral. */
function badgeStyle(rgb, neutral) {
    const [top, bottom] = neutral ? [0.16, 0.08] : [0.34, 0.16];
    const base = neutral ? [1, 1, 1] : rgb;
    return `background-gradient-direction: vertical; background-gradient-start: ${css(base, top)}; ` +
        `background-gradient-end: ${css(base, bottom)};`;
}

export const PeekView = GObject.registerClass(
class PeekView extends St.Widget {
    _init() {
        super._init({style_class: 'isle-peek', layout_manager: new Clutter.BinLayout()});

        // The content sits in one row, centred; the island fits its width.
        this._row = new St.BoxLayout({
            style_class: 'isle-peek-row',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
        });
        this.add_child(this._row);

        // Leading: one of these sits in the badge bin.
        this._badge = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({icon_size: 16});
        // Cover art, with the playing app's icon on its corner.
        this._art = new Art({size: 32, radius: 8});
        this._art.connect('shown', () => this._syncArtBadge());
        this._artBadgeIcon = new St.Icon({icon_size: 12});
        this._artBadge = new St.Bin({
            style_class: 'isle-app-badge',
            child: this._artBadgeIcon,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            translation_x: 4,
            translation_y: 4,
        });
        // Not widened by the badge's expand flags; see `_art()` in pages/media.js.
        this._artBox = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: false, y_expand: false});
        this._artBox.add_child(this._art);
        this._artBox.add_child(this._artBadge);
        // A level as a ring around a lit badge, like the other alerts' badges.
        this._ringIcon = new St.Icon({icon_size: 12});
        this._ringBadge = new St.Bin({style_class: 'isle-peek-ring-badge', child: this._ringIcon});
        this._ring = new Ring({size: 32, lineWidth: 3, child: this._ringBadge});
        this._row.add_child(this._badge);

        const texts = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = new St.Label({style_class: 'isle-peek-title'});
        this._subtitle = new St.Label({style_class: 'isle-peek-subtitle'});
        for (const text of [this._title, this._subtitle]) {
            text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            texts.add_child(text);
        }
        this._row.add_child(texts);

        // Trailing: a value, a level bar or a button.
        this._accessory = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        this._value = new St.Label({style_class: 'isle-peek-value', y_align: Clutter.ActorAlign.CENTER});
        this._status = new St.Label({style_class: 'isle-peek-status', y_align: Clutter.ActorAlign.CENTER});
        this._level = new LevelBar({width: 72});
        this._levelText = new St.Label({style_class: 'isle-peek-level-text', y_align: Clutter.ActorAlign.CENTER});
        this._levelBox = new St.BoxLayout({style_class: 'isle-peek-level-box'});
        this._levelBox.add_child(this._level);
        this._levelBox.add_child(this._levelText);
        this._row.add_child(this._accessory);

        this._actionButton = null;
        this._ringKey = null;
        this.connect('destroy', () => this._onDestroy());
    }

    /** The app's icon on the cover's corner, unless the cover already is that icon. */
    _syncArtBadge() {
        this._artBadge.visible = Boolean(this._artBadgeIcon.gicon) && !this._art.showsIcon;
    }

    /** Fills the view from an alert (see the top of this file); `onDone` runs after its button did its job. */
    setAlert(alert, onDone = null) {
        const rgb = TONE_COLORS[alert.tone] ?? TONE_COLORS.neutral;
        const color = css(rgb);
        const gicon = alert.gicon ?? icon(alert.icon ?? 'dialog-information-symbolic');
        const hasRing = alert.ring !== undefined && alert.ring !== null;

        if (alert.art !== undefined) {
            this._artBadgeIcon.gicon = alert.badge ?? null;
            this._art.setPath(alert.art);
            this._syncArtBadge();
            this._setChild(this._badge, this._artBox);
            this._badge.style_class = '';
        } else if (hasRing) {
            this._ring.color = rgb;
            this._ringIcon.gicon = gicon;
            this._ringIcon.style = `color: ${color};`;
            this._ringBadge.style = badgeStyle(rgb, (alert.tone ?? 'neutral') === 'neutral');
            this._setChild(this._badge, this._ring);
            this._badge.style_class = '';
            // Sweep only when the alert is new, not when it updates in place.
            const ringKey = `${alert.key}:${alert.title}`;
            if (ringKey !== this._ringKey)
                this._ring.fillTo(alert.ring, {delay: RING_DELAY});
            else
                this._ring.progress = alert.ring;
            this._ringKey = ringKey;
        } else {
            // An app's own colour icon stands alone; a symbolic one gets a badge.
            const appIcon = alert.appIcon && !isSymbolic(gicon);
            this._icon.gicon = gicon;
            this._icon.icon_size = appIcon ? 28 : 16;
            this._icon.style = appIcon ? null : `color: ${color};`;
            this._setChild(this._badge, this._icon);
            this._badge.style_class = appIcon ? '' : 'isle-peek-icon';
        }
        this._badge.style = this._badge.style_class
            ? badgeStyle(rgb, (alert.tone ?? 'neutral') === 'neutral')
            : null;
        if (!hasRing)
            this._ringKey = null;

        this._title.text = alert.title ?? '';
        this._subtitle.text = alert.subtitle ?? '';
        this._subtitle.visible = Boolean(alert.subtitle);

        this._actionButton?.destroy();
        this._actionButton = null;
        if (alert.action) {
            this._actionButton = pillButton(alert.action.label, 'isle-pill-small', () => {
                alert.action.callback();
                onDone?.();
            });
            this._setChild(this._accessory, this._actionButton);
        } else if (alert.level !== undefined && alert.level !== null) {
            this._level.level = alert.level;
            this._level.fillColor = color;
            this._levelText.text = alert.levelText ?? '';
            this._levelText.visible = Boolean(alert.levelText);
            this._setChild(this._accessory, this._levelBox);
        } else if (alert.value) {
            this._value.text = alert.value;
            this._setChild(this._accessory, this._value);
        } else if (alert.status) {
            this._status.text = alert.status;
            this._status.style = `color: ${color}; background-color: ${css(alert.tone === 'neutral' || !alert.tone ? [1, 1, 1] : rgb, 0.14)};`;
            this._setChild(this._accessory, this._status);
        } else {
            this._setChild(this._accessory, null);
        }
    }

    /** The height below the top bar this alert needs: less with a title alone. */
    get preferredHeight() {
        return this._subtitle.visible ? HEIGHT.two : HEIGHT.one;
    }

    /** The width the island should have for this alert. */
    get preferredWidth() {
        const [, natural] = this._row.get_preferred_width(-1);
        return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, natural)));
    }

    _setChild(bin, child) {
        if (bin.child !== child)
            bin.child = child;
    }

    _onDestroy() {
        // Pieces not currently shown are not children and must be freed here.
        for (const actor of [this._icon, this._artBox, this._ring, this._value, this._status, this._levelBox]) {
            if (!actor.get_parent())
                actor.destroy();
        }
    }
});
