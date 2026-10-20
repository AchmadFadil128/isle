// SPDX-License-Identifier: GPL-3.0-or-later

// Short-lived alerts the island grows to show: charging, earbuds, volume
// and brightness, keyboard, reminders, a new song...
//
// An alert is a plain object:
//   {
//     key,       // alerts with the same key replace each other in place
//     icon,      // icon name, or
//     gicon,     // a Gio.Icon, or
//     glyph,     // a character drawn instead of an icon (e.g. '⇪'), or
//     art,       // a cover art path
//     appIcon,   // true: show the icon large and uncircled (notifications)
//     ring,      // 0..1 draws a ring around the icon that sweeps up to it
//     title, subtitle,
//     tone,      // 'neutral' | 'good' | 'warn' | 'bad' | 'focus' | 'break'
//     value,     // large text on the right, e.g. '70%'
//     level,     // 0..1 shows a level bar on the right, with levelText
//     action,    // {label, callback} shows a button on the right
//     duration,  // milliseconds on screen
//     onActivate,// called when the alert itself is clicked
//     page,      // expanded page to open when hovered
//     priority,  // 'instant' alerts (OSD) replace whatever is showing
//     transient, // dropped rather than queued while the island is open
//   }

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Art, LevelBar, Ring, icon, pillButton} from './widgets.js';

export const PEEK_WIDTH = 380;
/** Height of the part that hangs below the top bar. */
export const PEEK_HEIGHT = 56;

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

const css = ([r, g, b]) => `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

export const PeekView = GObject.registerClass(
class PeekView extends St.BoxLayout {
    _init() {
        super._init({style_class: 'isle-peek'});

        // Leading: one of these sits in the badge bin.
        this._badge = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({icon_size: 18});
        this._glyph = new St.Label({style_class: 'isle-peek-glyph', y_align: Clutter.ActorAlign.CENTER});
        this._art = new Art({size: 38, radius: 10});
        this._ringIcon = new St.Icon({icon_size: 14});
        this._ring = new Ring({size: 38, lineWidth: 4.5, child: this._ringIcon});
        this.add_child(this._badge);

        const texts = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = new St.Label({style_class: 'isle-peek-title'});
        this._subtitle = new St.Label({style_class: 'isle-peek-subtitle'});
        for (const text of [this._title, this._subtitle]) {
            text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            texts.add_child(text);
        }
        this.add_child(texts);

        // Trailing: a value, a level bar or a button.
        this._accessory = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        this._value = new St.Label({style_class: 'isle-peek-value', y_align: Clutter.ActorAlign.CENTER});
        this._level = new LevelBar({width: 96});
        this._levelText = new St.Label({style_class: 'isle-peek-level-text', y_align: Clutter.ActorAlign.CENTER});
        this._levelBox = new St.BoxLayout({style_class: 'isle-peek-level-box'});
        this._levelBox.add_child(this._level);
        this._levelBox.add_child(this._levelText);
        this.add_child(this._accessory);

        this._actionButton = null;
        this._ringKey = null;
        this.connect('destroy', () => this._onDestroy());
    }

    /** Fills the view from an alert (see the top of this file). */
    setAlert(alert) {
        const rgb = TONE_COLORS[alert.tone] ?? TONE_COLORS.neutral;
        const color = css(rgb);
        const gicon = alert.gicon ?? icon(alert.icon ?? 'dialog-information-symbolic');
        const hasRing = alert.ring !== undefined && alert.ring !== null;

        if (alert.art !== undefined) {
            this._art.setPath(alert.art);
            this._setChild(this._badge, this._art);
            this._badge.style_class = '';
        } else if (hasRing) {
            this._ring.color = rgb;
            this._ringIcon.gicon = gicon;
            this._setChild(this._badge, this._ring);
            this._badge.style_class = '';
            // Sweep only when the alert is new, not when it updates in place.
            const ringKey = `${alert.key}:${alert.title}`;
            if (ringKey !== this._ringKey)
                this._ring.fillTo(alert.ring, {delay: RING_DELAY});
            else
                this._ring.progress = alert.ring;
            this._ringKey = ringKey;
        } else if (alert.glyph) {
            this._glyph.text = alert.glyph;
            this._glyph.style = `color: ${color};`;
            this._setChild(this._badge, this._glyph);
            this._badge.style_class = 'isle-peek-icon';
        } else {
            this._icon.gicon = gicon;
            this._icon.icon_size = alert.appIcon ? 34 : 18;
            this._icon.style = alert.appIcon ? null : `color: ${color};`;
            this._setChild(this._badge, this._icon);
            this._badge.style_class = alert.appIcon ? '' : 'isle-peek-icon';
        }
        if (!hasRing)
            this._ringKey = null;

        this._title.text = alert.title ?? '';
        this._subtitle.text = alert.subtitle ?? '';
        this._subtitle.visible = Boolean(alert.subtitle);

        this._actionButton?.destroy();
        this._actionButton = null;
        if (alert.action) {
            this._actionButton = pillButton(alert.action.label, 'isle-pill-small', alert.action.callback);
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
        } else {
            this._setChild(this._accessory, null);
        }
    }

    _setChild(bin, child) {
        if (bin.child !== child)
            bin.child = child;
    }

    _onDestroy() {
        // Pieces not currently shown are not children and must be freed here.
        for (const actor of [this._icon, this._glyph, this._art, this._ring, this._value, this._levelBox]) {
            if (!actor.get_parent())
                actor.destroy();
        }
    }
});
