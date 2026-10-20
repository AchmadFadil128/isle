// SPDX-License-Identifier: GPL-3.0-or-later

// The island itself: a black shape hanging from the top bar that morphs
// between sizes with spring physics and cross-fades between views.
//
//   ┌──────────── top bar (black) ────────────┐
//   └───────╮                       ╭─────────┘   <- concave shoulders
//           │        content        │
//           ╰───────────────────────╯             <- rounded corners

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {GENTLE, Spring, SpringDriver} from './spring.js';


/**
 * Sideways speed (px/s) given to the island by `nudge`: a stretch of about
 * 15 px that springs back, like iOS when the volume is already at its limit.
 */
const NUDGE_VELOCITY = 220;

/** Cross-fade timings in milliseconds. */
const FADE_OUT = 160;
const FADE_IN = 320;
/** The incoming view waits for the shape to make room before appearing. */
const FADE_IN_DELAY = 200;

export const Island = GObject.registerClass({
    Properties: {
        // How strongly `tint` washes the island, so it can fade in and out.
        'tint-strength': GObject.ParamSpec.double('tint-strength', null, null,
            GObject.ParamFlags.READWRITE, 0, 1, 0),
    },
    Signals: {'geometry-changed': {}},
}, class Island extends St.Widget {
    _init() {
        super._init({
            name: 'isleIsland',
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.FixedLayout(),
        });

        /** Height of the top bar, which the island always covers. */
        this._topInset = 0;
        this._monitor = null;
        this._view = null;
        this._tint = null;
        this._tintStrength = 0;

        this._width = new Spring(0);
        this._height = new Spring(0);
        this._radius = new Spring(0, GENTLE);
        this._shoulder = new Spring(0, GENTLE);
        this._springs = [this._width, this._height, this._radius, this._shoulder];
        this._driver = new SpringDriver(this, this._springs, () => this._sync());

        this._shape = new St.DrawingArea();
        this._shape.connect('repaint', area => this._repaint(area));
        this.add_child(this._shape);

        // Views are centred at the top of this box, which clips them to the
        // island's body while it is still growing. (Clutter.BinLayout only
        // honours START/END alignment for children that also expand.)
        this._stage = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
        });
        this.add_child(this._stage);
        this.connect('destroy', () => this._onDestroy());
    }

    /** The top bar's height; the island's body starts below it. */
    set topInset(height) {
        this._topInset = height;
        this._sync();
    }

    get topInset() {
        return this._topInset;
    }

    /** The monitor to centre on: `{x, y, width, height}`. */
    set monitor(monitor) {
        this._monitor = monitor;
        this._sync();
    }

    get tint_strength() {
        return this._tintStrength;
    }

    set tint_strength(value) {
        this._tintStrength = value;
        this.notify('tint-strength');
        this._shape.queue_repaint();
    }

    /** RGB colour washed into the bottom of the island, or null for none. */
    set tint(rgb) {
        if (rgb)
            this._tint = rgb;
        this.remove_transition('tint-strength');
        this.ease_property('tint-strength', rgb ? 1 : 0, {
            duration: 450,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /** Whether the island has finished moving. */
    get isSettled() {
        return this._springs.every(spring => spring.settled);
    }

    /**
     * Animates to `size` ({width, height, radius, shoulder}) and shows
     * `view`, which should already be sized to fit.
     */
    morph(size, view) {
        this._width.setTarget(size.width);
        this._height.setTarget(size.height);
        this._radius.setTarget(size.radius);
        this._shoulder.setTarget(size.shoulder);

        // The first shape appears without animating: an island of zero size
        // is on no monitor, so it would get no frames to animate with.
        const firstShow = this._view === null;
        if (firstShow || !St.Settings.get().enable_animations) {
            for (const spring of this._springs)
                spring.reset(spring.target);
            this._sync();
        } else {
            this._driver.start();
        }
        this._showView(view);
    }

    /**
     * Adds a view, hidden. Every view is added up front so it is always on
     * the stage, even before it is first shown.
     */
    addView(view) {
        view.x_expand = view.y_expand = true;
        view.x_align = Clutter.ActorAlign.CENTER;
        view.y_align = Clutter.ActorAlign.START;
        view.opacity = 0;
        view.reactive = false;
        view.hide();
        this._stage.add_child(view);
    }

    /** A quick rubber-band stretch, e.g. pressing volume up at 100%. */
    nudge() {
        if (!St.Settings.get().enable_animations)
            return;
        this._width.velocity += NUDGE_VELOCITY;
        this._driver.start();
    }

    _showView(view) {
        if (view === this._view)
            return;

        const previous = this._view;
        if (previous) {
            previous.remove_all_transitions();
            previous.reactive = false;
            previous.ease({
                opacity: 0,
                duration: FADE_OUT,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: finished => {
                    if (finished)
                        previous.hide();
                },
            });
        }

        this._view = view;
        view.remove_all_transitions();
        view.reactive = true;
        view.show();
        view.opacity = 0;
        view.ease({
            opacity: 255,
            delay: previous ? FADE_IN_DELAY : 0,
            duration: FADE_IN,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _sync() {
        const width = Math.max(0, this._width.value);
        const height = Math.max(0, this._height.value);
        // The actor spans the body plus a shoulder on each side.
        const margin = Math.max(0, this._shoulder.value);
        const outerWidth = width + 2 * margin;

        this.set_size(Math.ceil(outerWidth), Math.ceil(height));
        this._shape.set_size(Math.ceil(outerWidth), Math.ceil(height));
        this._stage.set_position(margin, 0);
        this._stage.set_size(Math.ceil(width), Math.ceil(height));
        this._shape.queue_repaint();

        if (this._monitor) {
            const {x, y, width: monitorWidth} = this._monitor;
            // Whole pixels keep text sharp while the island resizes.
            this.set_position(Math.round(x + (monitorWidth - outerWidth) / 2), y);
        }
        this.emit('geometry-changed');
    }

    _repaint(area) {
        const cr = area.get_context();
        const [, height] = area.get_surface_size();
        const top = Math.min(this._topInset, height);
        // Shoulders and corners must share the part below the top bar.
        const margin = Math.max(0, this._shoulder.value);
        const shoulder = Math.min(margin, Math.max(0, (height - top) / 2));
        const left = margin;
        const right = left + Math.max(0, this._width.value);
        const radius = Math.max(0, Math.min(this._radius.value, height - top - shoulder, (right - left) / 2));

        cr.moveTo(left - shoulder, 0);
        cr.lineTo(right + shoulder, 0);
        cr.lineTo(right + shoulder, top);
        cr.arcNegative(right + shoulder, top + shoulder, shoulder, -Math.PI / 2, -Math.PI);
        cr.lineTo(right, height - radius);
        cr.arc(right - radius, height - radius, radius, 0, Math.PI / 2);
        cr.arc(left + radius, height - radius, radius, Math.PI / 2, Math.PI);
        cr.lineTo(left, top + shoulder);
        cr.arcNegative(left - shoulder, top + shoulder, shoulder, 0, -Math.PI / 2);
        cr.closePath();

        cr.setSourceRGBA(0, 0, 0, 1);
        if (this._tint && this._tintStrength > 0) {
            cr.fillPreserve();
            // Black under the top bar, deepening to the cover's colour.
            const [r, g, b] = this._tint;
            const gradient = new Cairo.LinearGradient(0, top, 0, height);
            gradient.addColorStopRGBA(0, r, g, b, 0);
            gradient.addColorStopRGBA(1, r, g, b, 0.75 * this._tintStrength);
            cr.setSource(gradient);
        }
        cr.fill();
        cr.$dispose();
    }

    _onDestroy() {
        this._driver?.destroy();
        this._driver = null;
    }
});
