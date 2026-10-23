// SPDX-License-Identifier: GPL-3.0-or-later

// Short-lived alerts the island grows to show. An alert: {key (same key replaces), icon | gicon | art, badge,
// appIcon, ring, ringIconSize, volume, title, titleLines, subtitle, tone, value, status, level, action, duration, onActivate, page,
// priority, transient, motion (the icon's, once; see `playMotion` in widgets.js)}.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL} from './compat.js';
import * as Palette from './palette.js';
import {Art, LevelBar, Ring, VolumeGlyph, icon, isSymbolic, ownIcon, pillButton, playMotion, wrapLines} from './widgets.js';

/** Narrowest and widest an alert gets; in between it fits its content. */
const MIN_WIDTH = 220;
const MAX_WIDTH = 380;
/** Height of the part that hangs below the top bar: a line of text, or two. */
const HEIGHT = {one: 44, two: 52};
/** A two-line title's width: the widest alert less its padding (14 + 14), badge (32) and spacing (10). */
const TITLE_WRAP_WIDTH = MAX_WIDTH - 70;

/** The ring starts sweeping once the island has made room; a level bar grows a little sooner. */
const RING_DELAY = 350;
const LEVEL_DELAY = 200;
/** As wide as a digit in tabular figures: a counting "7%" keeps the width of "64%". */
const FIGURE_SPACE = '\u2007';

const TONE_COLORS = {
    neutral: Palette.WHITE,
    good: Palette.GREEN,
    focus: Palette.GREEN,
    bad: Palette.RED,
    // The plans' colours on the Usage page (see pages/usage.js).
    claude: [0.85, 0.47, 0.34],
    codex: [0.06, 0.64, 0.5],
    break: Palette.BLUE,
    calendar: Palette.BLUE,
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
        this._volume = new VolumeGlyph();
        this._row.add_child(this._badge);

        const texts = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._title = new St.Label({style_class: 'isle-peek-title'});
        this._subtitle = new St.Label({style_class: 'isle-peek-subtitle'});
        for (const text of [this._title, this._subtitle]) {
            text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            texts.add_child(text);
        }
        // Set up to wrap without hyphens; it wraps only for an alert that asks (see `setAlert`).
        wrapLines(this._title, Pango.EllipsizeMode.END);
        this._title.clutter_text.line_wrap = false;
        this._titleLines = 1;
        this._lineHeight = 0;
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
        this._forget();
        /** A value counting up with the ring's sweep: {final, digits, target}. */
        this._count = null;
        this._ring.connect('notify::progress', () => this._syncCount());
        // Put away, the next alert here is a new one and animates in.
        this.connect('notify::mapped', () => {
            if (!this.mapped)
                this._forget();
        });
        this.connect('destroy', () => this._onDestroy());
    }

    /** The app's icon on the cover's corner, unless the cover already is that icon. */
    _syncArtBadge() {
        this._artBadge.visible = Boolean(this._artBadgeIcon.gicon) && !this._art.showsIcon;
    }

    /** What the alert shown last was, so one updating in place doesn't animate in again. */
    _forget() {
        this._ringKey = this._levelKey = this._volumeKey = this._motionKey = null;
    }

    /** Fills the view from an alert (see the top of this file); `onDone` runs after its button did its job.
     * `fresh` for one just shown, though its key is the last one's (a second "Charging"). */
    setAlert(alert, onDone = null, {fresh = false} = {}) {
        if (fresh)
            this._forget();
        const rgb = TONE_COLORS[alert.tone] ?? TONE_COLORS.neutral;
        const color = css(rgb);
        const gicon = alert.gicon ? ownIcon(alert.gicon) : icon(alert.icon ?? 'dialog-information-symbolic');
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
            this._ringIcon.icon_size = alert.ringIconSize ?? 12;
            this._ringIcon.style = `color: ${color};`;
            this._ringBadge.style = badgeStyle(rgb, (alert.tone ?? 'neutral') === 'neutral');
            this._setChild(this._badge, this._ring);
            this._badge.style_class = '';
            // Sweep only when the alert is new, not when it updates in place.
            const ringKey = `${alert.key}:${alert.title}`;
            if (ringKey !== this._ringKey)
                this._ring.fillTo(alert.ring, {delay: RING_DELAY});
            else
                this._ring.jumpTo(alert.ring);
            this._ringKey = ringKey;
        } else if (alert.volume) {
            // A new volume alert brings its waves in; changes while shown add or take away one.
            this._volume.setLevel(alert.volume.level, alert.volume.muted, {fresh: alert.key !== this._volumeKey});
            this._volume.style = `color: ${color};`;
            this._setChild(this._badge, this._volume);
            this._badge.style_class = 'isle-peek-icon';
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
        this._volumeKey = alert.volume ? alert.key : null;
        // Its icon's motion plays once, for a new alert (not one updating in place), once the island made room.
        const moving = hasRing ? this._ringIcon : alert.art === undefined && !alert.volume ? this._icon : null;
        const motionKey = `${alert.key}:${alert.title}`;
        if (moving && motionKey !== this._motionKey)
            playMotion(moving, alert.motion, {delay: RING_DELAY});
        this._motionKey = motionKey;

        // Two lines at most for a title that may run long (an answer); the island widens and grows by the
        // line. Cut here: with wrapping, Pango's own … would keep the first line alone.
        let title = alert.title ?? '';
        this._titleLines = 1;
        if (alert.titleLines === 2)
            [title, this._titleLines, this._lineHeight] = this._fitLines(title, 2);
        const wrap = this._titleLines > 1;
        this._title.clutter_text.line_wrap = wrap;
        this._title.clutter_text.ellipsize = wrap ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
        // Its height set: the column would measure a wrapped title as one line and sit off centre.
        this._title.height = wrap ? Math.ceil(this._titleLines * this._lineHeight) : -1;
        this._title.text = title;
        this._subtitle.text = alert.subtitle ?? '';
        this._subtitle.visible = Boolean(alert.subtitle);

        this._actionButton?.destroy();
        this._actionButton = null;
        this._count = null;
        if (alert.level === undefined || alert.level === null || alert.action)
            this._levelKey = null;
        if (alert.action) {
            // The one thing to do now (Join) in the accent colour, as macOS's default button.
            this._actionButton = pillButton(alert.action.label, alert.action.primary ? 'isle-pill-small isle-pill-accent' : 'isle-pill-small', () => {
                alert.action.callback();
                onDone?.();
            });
            this._setChild(this._accessory, this._actionButton);
        } else if (alert.level !== undefined && alert.level !== null) {
            if (alert.key !== this._levelKey)
                this._level.growTo(alert.level, {delay: LEVEL_DELAY});
            else
                this._level.level = alert.level;
            this._levelKey = alert.key;
            this._level.fillColor = color;
            this._levelText.text = alert.levelText ?? '';
            this._levelText.visible = Boolean(alert.levelText);
            this._setChild(this._accessory, this._levelBox);
        } else if (alert.value) {
            const counted = hasRing && alert.ring > 0 && /^(\d+)%$/.exec(alert.value);
            this._count = counted ? {final: Number(counted[1]), digits: counted[1].length, target: alert.ring, shown: -1} : null;
            this._value.text = alert.value;
            this._syncCount();
            this._setChild(this._accessory, this._value);
        } else if (alert.status) {
            this._status.text = alert.status;
            this._status.style = `color: ${color}; background-color: ${css(alert.tone === 'neutral' || !alert.tone ? [1, 1, 1] : rgb, 0.14)};`;
            this._setChild(this._accessory, this._status);
        } else {
            this._setChild(this._accessory, null);
        }
    }

    /** A ring's percentage counts up as it sweeps. */
    _syncCount() {
        if (!this._count)
            return;
        const {final, digits, target} = this._count;
        const shown = Math.min(final, Math.round(final * this._ring.progress / target));
        // Set each frame of the sweep, but changed only now and then (and not at all in its slow end).
        if (shown === this._count.shown)
            return;
        this._count.shown = shown;
        this._value.text = `${String(shown).padStart(digits, FIGURE_SPACE)}%`;
    }

    /** The height below the top bar this alert needs: less with a title alone. */
    get preferredHeight() {
        const height = this._subtitle.visible ? HEIGHT.two : HEIGHT.one;
        return height + Math.round((this._titleLines - 1) * this._lineHeight);
    }

    /** `text` cut to whole words that fit in `max` lines of a two-line title, with … if cut (by letters when
     * one word is too long: a link): [text, lines, line height]. */
    _fitLines(text, max) {
        const layout = Pango.Layout.new(this._title.get_pango_context());
        layout.set_font_description(this._title.get_theme_node().get_font());
        layout.set_attributes(this._title.clutter_text.get_attributes());
        layout.set_width(TITLE_WRAP_WIDTH * Pango.SCALE);
        layout.set_wrap(Pango.WrapMode.WORD_CHAR);
        const fits = candidate => {
            layout.set_text(candidate, -1);
            return layout.get_line_count() <= max;
        };
        // No more than the lines could hold of the narrowest letters is measured: a long answer costs no more.
        const room = Math.ceil(max * TITLE_WRAP_WIDTH / 2.5);
        const letters = [...text];
        let fitted = letters.length > room ? letters.slice(0, room).join('') : text;
        if (!fits(fitted) || fitted !== text) {
            // Pango broke the lines already: up to where the last one ends (in bytes), then room for the ….
            const end = layout.get_line_count() > max ? layout.get_line_readonly(max - 1) : null;
            let words = fitted;
            if (end)
                words = new TextDecoder().decode(new TextEncoder().encode(fitted).subarray(0, end.start_index + end.length));
            words = words.trimEnd().split(' ');
            // Cut through by `room` (not at a line's end): its last word is only part of one.
            if (!end && words.length > 1)
                words.pop();
            for (;;) {
                fitted = `${words.join(' ').replace(/[\s,.;:]+$/, '')}…`;
                if (fits(fitted) || fitted.length <= 1)
                    break;
                if (words.length > 1)
                    words.pop();
                else
                    words = [[...words[0]].slice(0, -1).join('')];
            }
        }
        layout.set_text(fitted, -1);
        const count = layout.get_line_count();
        const [, logical] = layout.get_pixel_extents();
        return [fitted, Math.min(max, count), logical.height / count];
    }

    /** The width the island should have for this alert. */
    get preferredWidth() {
        const [, natural] = this._row.get_preferred_width(-1);
        if (this._titleLines > 1)
            return MAX_WIDTH;
        return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, natural)));
    }

    _setChild(bin, child) {
        if (bin.child !== child)
            bin.child = child;
        // An empty slot takes no room (nor the row's spacing), so the rest stays centred.
        bin.visible = child !== null;
    }

    _onDestroy() {
        // Pieces not currently shown are not children and must be freed here.
        for (const actor of [this._icon, this._artBox, this._ring, this._volume, this._value, this._status, this._levelBox]) {
            if (!actor.get_parent())
                actor.destroy();
        }
    }
});
