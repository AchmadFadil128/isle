// SPDX-License-Identifier: GPL-3.0-or-later

// Small building blocks shared by the island's views.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';

let iconDir = null;

/** Tells `icon()` where the extension's bundled icons live. */
export function setIconDir(dir) {
    iconDir = dir;
}

/**
 * A `Gio.Icon` for `name`: one of the extension's own icons (in `icons/`)
 * if it exists, otherwise a themed icon. The bundled icons are white line
 * drawings, deliberately not named `-symbolic`: GNOME recolours symbolic
 * icons by filling every shape, which would turn outlines into solid blobs.
 */
export function icon(name) {
    const file = iconDir?.get_child(`${name}.svg`);
    if (file?.query_exists(null))
        return new Gio.FileIcon({file});
    return new Gio.ThemedIcon({name});
}

export function label(text, styleClass, props = {}) {
    return new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
}

/** A round icon button. */
export function iconButton(iconName, styleClass, onClick, {size = 16, accessibleName = ''} = {}) {
    const button = new St.Button({
        style_class: `isle-button ${styleClass}`,
        child: new St.Icon({gicon: icon(iconName), icon_size: size}),
        can_focus: true,
        accessible_name: accessibleName,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', () => onClick());
    return button;
}

/** A pill-shaped text button. */
export function pillButton(text, styleClass, onClick) {
    const button = new St.Button({
        style_class: `isle-pill ${styleClass}`,
        label: text,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', () => onClick());
    return button;
}

/** A pill with an icon and a label; change its state with `setChip`. */
export function chipButton(iconName, text, onClick, styleClass = '') {
    const box = new St.BoxLayout({style_class: 'isle-chip-box'});
    const glyph = new St.Icon({gicon: icon(iconName), icon_size: 14});
    const caption = new St.Label({text, y_align: Clutter.ActorAlign.CENTER});
    box.add_child(glyph);
    box.add_child(caption);
    const button = new St.Button({style_class: `isle-chip ${styleClass}`, child: box, can_focus: true, y_align: Clutter.ActorAlign.CENTER});
    button.connect('clicked', () => onClick());
    button._isleIcon = glyph;
    button._isleCaption = caption;
    return button;
}

/**
 * Updates a chip's state. A state change always changes the icon too (e.g.
 * outline to filled), never just the colour.
 */
export function setChip(button, {active = false, icon: iconName = null, label: text = null, enabled = true}) {
    if (iconName)
        button._isleIcon.gicon = icon(iconName);
    if (text)
        button._isleCaption.text = text;
    if (active)
        button.add_style_pseudo_class('checked');
    else
        button.remove_style_pseudo_class('checked');
    // Disabled chips stay in place, dimmed, so the layout never jumps.
    button.reactive = enabled;
    button.can_focus = enabled;
}

/** Sets an icon button's icon. */
export function setButtonIcon(button, iconName) {
    button.child.gicon = icon(iconName);
}

/**
 * A circular progress ring, optionally with a child centred inside it.
 * `progress` is a GObject property, so it can be animated with `ease_property`.
 */
export const Ring = GObject.registerClass({
    Properties: {
        'progress': GObject.ParamSpec.double('progress', null, null,
            GObject.ParamFlags.READWRITE, 0, 1, 0),
    },
}, class Ring extends St.Widget {
    _init({size, lineWidth = 2.5, color = [1, 1, 1], trackOpacity = 0.18, child = null}) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            width: size,
            height: size,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._progress = 0;
        this._lineWidth = lineWidth;
        this._color = color;
        this._trackOpacity = trackOpacity;

        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', area => this._repaint(area));
        this.add_child(this._area);
        if (child) {
            child.x_align = child.y_align = Clutter.ActorAlign.CENTER;
            this.add_child(child);
        }
    }

    get progress() {
        return this._progress;
    }

    set progress(value) {
        const clamped = Math.min(1, Math.max(0, value));
        if (Math.abs(clamped - this._progress) < 0.001)
            return;
        this._progress = clamped;
        this.notify('progress');
        this._area.queue_repaint();
    }

    /** Sweeps from empty to `progress`, like the charging ring. */
    fillTo(progress, {delay = 0} = {}) {
        this.remove_transition('progress');
        this.progress = 0;
        this.ease_property('progress', progress, {
            delay,
            duration: 1000,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    set color(rgb) {
        this._color = rgb;
        this._area.queue_repaint();
    }

    _repaint(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const radius = Math.min(width, height) / 2 - this._lineWidth / 2;
        const [r, g, b] = this._color;
        cr.setLineWidth(this._lineWidth);
        cr.setLineCap(1); // round

        cr.setSourceRGBA(r, g, b, this._trackOpacity);
        cr.arc(width / 2, height / 2, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (this._progress > 0) {
            const start = -Math.PI / 2;
            cr.setSourceRGBA(r, g, b, 1);
            cr.arc(width / 2, height / 2, radius, start, start + this._progress * 2 * Math.PI);
            cr.stroke();
        }
        cr.$dispose();
    }
});

/** Equaliser bars that dance while music plays. */
export const Bars = GObject.registerClass(
class Bars extends St.BoxLayout {
    _init({height = 14, count = 4} = {}) {
        super._init({style_class: 'isle-bars', y_align: Clutter.ActorAlign.CENTER, height});
        this._maxHeight = height;
        this._playing = false;
        this._bars = [];
        for (let i = 0; i < count; i++) {
            const bar = new St.Widget({style_class: 'isle-bar', y_align: Clutter.ActorAlign.CENTER});
            bar.height = this._restHeight(i);
            this._bars.push(bar);
            this.add_child(bar);
        }
    }

    _restHeight(index) {
        // A fixed "|ılı" silhouette when not animating.
        return this._maxHeight * [0.45, 1, 0.7, 0.35, 0.8][index % 5];
    }

    /** Animates the bars. Costs a redraw per frame, so only use when visible. */
    set playing(playing) {
        if (playing === this._playing)
            return;
        this._playing = playing;
        this._bars.forEach((bar, index) => {
            bar.remove_all_transitions();
            if (playing)
                this._bounce(bar);
            else
                bar.ease({height: this._restHeight(index), duration: 200});
        });
    }

    _bounce(bar) {
        if (!this._playing)
            return;
        bar.ease({
            height: this._maxHeight * (0.25 + Math.random() * 0.75),
            duration: 180 + Math.random() * 220,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            onStopped: finished => {
                if (finished)
                    this._bounce(bar);
            },
        });
    }

    vfunc_destroy() {
        this._playing = false;
        super.vfunc_destroy();
    }
});

/** Square cover art with rounded corners and a placeholder. */
export const Art = GObject.registerClass(
class Art extends St.Bin {
    _init({size, radius}) {
        super._init({
            style_class: 'isle-art',
            width: size,
            height: size,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._radius = radius;
        this._path = null;
        this._placeholder = new St.Icon({
            gicon: icon('isle-music'),
            icon_size: Math.round(size * 0.42),
            style_class: 'isle-art-placeholder',
        });
        this.setPath('');
    }

    setPath(path) {
        if (path === this._path)
            return;
        this._path = path;
        const base = `border-radius: ${this._radius}px;`;
        if (path) {
            const uri = GLib.filename_to_uri(path, null).replace(/"/g, '%22');
            this.style = `${base} background-image: url("${uri}"); background-size: cover;`;
            this.child = null;
        } else {
            this.style = base;
            this.child = this._placeholder;
        }
    }
});

/** A thin horizontal level meter. */
export const LevelBar = GObject.registerClass(
class LevelBar extends St.Widget {
    _init({width, styleClass = ''}) {
        super._init({
            style_class: `isle-level ${styleClass}`,
            width,
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._fill = new St.Widget({style_class: 'isle-level-fill'});
        this.add_child(this._fill);
        this._level = 0;
        this.connect('notify::allocation', () => this._layout());
    }

    set level(value) {
        this._level = Math.min(1, Math.max(0, value));
        this._layout();
    }

    get level() {
        return this._level;
    }

    /** CSS colour of the filled part. */
    set fillColor(color) {
        this._fill.style = `background-color: ${color};`;
    }

    _layout() {
        const [width, height] = this.get_size();
        this._fill.set_size(Math.round(width * this._level), height);
    }
});

/**
 * Two eyes that blink, doze off and wake up again: the island's idle state.
 * Animations only run while the eyes are visible and end once asleep, so a
 * computer left alone costs no redraws.
 */
export const Eyes = GObject.registerClass(
class Eyes extends St.BoxLayout {
    _init() {
        super._init({style_class: 'isle-eyes', y_align: Clutter.ActorAlign.CENTER});
        this._eyes = [0, 1].map(() => {
            const eye = new St.Widget({style_class: 'isle-eye', y_align: Clutter.ActorAlign.CENTER});
            eye.set_pivot_point(0.5, 0.5);
            this.add_child(eye);
            return eye;
        });
        this._zzz = new St.Label({text: 'z', style_class: 'isle-zzz', opacity: 0, y_align: Clutter.ActorAlign.START});
        this.add_child(this._zzz);
        this._timeouts = new Set();
    }

    /** Eyes open, blink a couple of times, then slowly close. */
    doze() {
        this._clear();
        this._setLids(1, 0);
        this._later(1800, () => this._blink());
        this._later(3600, () => this._blink());
        this._later(6000, () => this._setLids(0.45, 900));
        this._later(8500, () => {
            this._setLids(0.12, 1200);
            this._zzz.ease({opacity: 200, translation_y: -3, duration: 1500, delay: 600});
        });
    }

    /** Eyes pop wide open. */
    wake() {
        this._clear();
        this._zzz.ease({opacity: 0, translation_y: 0, duration: 150});
        for (const eye of this._eyes) {
            eye.ease({
                scale_y: 1.25,
                scale_x: 1.1,
                duration: 160,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
                onComplete: () => eye.ease({scale_x: 1, scale_y: 1, duration: 220}),
            });
        }
    }

    _blink() {
        for (const eye of this._eyes) {
            eye.ease({
                scale_y: 0.1,
                duration: 90,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => eye.ease({scale_y: 1, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD}),
            });
        }
    }

    _setLids(openness, duration) {
        for (const eye of this._eyes)
            eye.ease({scale_y: openness, scale_x: 1, duration, mode: Clutter.AnimationMode.EASE_IN_OUT_SINE});
    }

    _later(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    _clear() {
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
    }

    vfunc_destroy() {
        this._clear();
        super.vfunc_destroy();
    }
});
