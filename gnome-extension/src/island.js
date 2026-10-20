// SPDX-License-Identifier: GPL-3.0-or-later

// The island itself: a black shape hanging from the top bar that morphs
// between sizes with spring physics and cross-fades between views.
//
//   ┌──────────── top bar (black) ────────────┐
//   └───────╮                       ╭─────────┘   <- concave shoulders
//           │        content        │
//           ╰───────────────────────╯             <- rounded corners
//
// On a bar that is not black it hangs from the screen's top edge instead,
// shoulders and all, like a MacBook's notch; closed, it can sit inside the
// bar, rounding its corners within it.

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

/** How long a tint takes to come and go: a wash, and a glow (which lingers out). */
const TINT_FADE = {wash: [450, 450], glow: [380, 1100]};

/** Cross-fade timings in milliseconds. */
const FADE_OUT = 160;
const FADE_IN = 320;
/** The incoming view waits for the shape to make room before appearing. */
const FADE_IN_DELAY = 200;
/**
 * Below this shoulder size (px) the corners may climb into the top bar, so
 * an island growing out of the bar rounds smoothly instead of jumping.
 */
const SHOULDER_FADE = 4;

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

        /** Height of the top bar the island grows out of; 0 for none. */
        this._topInset = 0;
        this._monitor = null;
        this._view = null;
        this._tint = null;
        this._tintStyle = 'wash';
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

        // Clips the views while the island grows; a fixed layout keeps them at
        // full size (a bin would squeeze them), so nothing reflows.
        this._stage = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: true,
        });
        this.add_child(this._stage);
        this.connect('destroy', () => this._onDestroy());
    }

    /** The height of the bar the island grows out of; its body starts below. */
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

    // Colours the island with `rgb` (0..1; null fades it): 'wash' rises to the bottom,
    // 'glow' spills up from the two bottom corners.
    setTint(rgb, style = 'wash') {
        if (rgb) {
            this._tint = rgb;
            this._tintStyle = style;
        }
        const [fadeIn, fadeOut] = TINT_FADE[this._tintStyle];
        this.remove_transition('tint-strength');
        this.ease_property('tint-strength', rgb ? 1 : 0, {
            duration: rgb ? fadeIn : fadeOut,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /** Where `actor` in the shown view will be once the island settles: {x, y, width, height}. */
    restingRect(actor) {
        if (!this._monitor || !this._view)
            return null;
        const margin = Math.max(0, this._shoulder.target);
        const width = Math.max(0, this._width.target);
        // As `_sync` and `_placeView` will place the view.
        const viewX = Math.round(this._monitor.x + (this._monitor.width - width - 2 * margin) / 2) +
            margin + Math.round((Math.ceil(width) - this._view.width) / 2);
        const [viewLeft, viewTop] = this._view.get_transformed_position();
        const [left, top] = actor.get_transformed_position();
        const [actorWidth, actorHeight] = actor.get_transformed_size();
        return {
            x: Math.round(viewX + left - viewLeft),
            y: Math.round(this._monitor.y + top - viewTop),
            width: Math.round(actorWidth),
            height: Math.round(actorHeight),
        };
    }

    /** Whether the island's shape, as it is right now, covers `rect`. */
    covers({x, y, width, height}) {
        const [left, top] = this.get_transformed_position();
        const bodyLeft = left + Math.max(0, this._shoulder.value);
        const bodyRight = bodyLeft + Math.max(0, this._width.value);
        return x >= bodyLeft && x + width <= bodyRight && y >= top &&
            y + height <= top + Math.max(0, this._height.value);
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
        view.connect('notify::width', () => this._placeView(view));
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

    /** Centres `view` at the top of the island's body. */
    _placeView(view) {
        view.set_position(Math.round((Math.ceil(Math.max(0, this._width.value)) - view.width) / 2), 0);
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
        for (const view of this._stage.get_children())
            this._placeView(view);
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
        // Shoulders and corners must share the part below the top bar; an
        // island without shoulders may round its corners inside the bar.
        const margin = Math.max(0, this._shoulder.value);
        const shoulder = Math.min(margin, Math.max(0, (height - top) / 2));
        const left = margin;
        const right = left + Math.max(0, this._width.value);
        const hanging = Math.min(1, margin / SHOULDER_FADE);
        const radius = Math.max(0, Math.min(this._radius.value, height - top * hanging - shoulder, (right - left) / 2));

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
        cr.fillPreserve();
        if (this._tint && this._tintStrength > 0) {
            for (const gradient of this._tintGradients(left, right, top, height)) {
                cr.setSource(gradient);
                cr.fillPreserve();
            }
        }
        cr.newPath();
        cr.$dispose();
    }

    /** The gradients that paint the tint over the black shape, in order. */
    _tintGradients(left, right, top, height) {
        const [r, g, b] = this._tint;
        const strength = this._tintStrength;
        if (this._tintStyle === 'glow') {
            // A pool of light at each bottom corner, joined by a faint band
            // along the bottom edge.
            const radius = Math.min((right - left) * 0.36, Math.max(0, height - top) * 1.05);
            const corners = [left + radius * 0.12, right - radius * 0.12].map(x => {
                const glow = new Cairo.RadialGradient(x, height + radius * 0.2, 0, x, height + radius * 0.2, radius);
                glow.addColorStopRGBA(0, r, g, b, 0.95 * strength);
                glow.addColorStopRGBA(0.4, r, g, b, 0.42 * strength);
                glow.addColorStopRGBA(1, r, g, b, 0);
                return glow;
            });
            const band = new Cairo.LinearGradient(0, height - radius * 0.4, 0, height);
            band.addColorStopRGBA(0, r, g, b, 0);
            band.addColorStopRGBA(1, r, g, b, 0.2 * strength);
            return [band, ...corners];
        }
        // Black under the top bar, deepening to the cover's colour.
        const wash = new Cairo.LinearGradient(0, top, 0, height);
        wash.addColorStopRGBA(0, r, g, b, 0);
        wash.addColorStopRGBA(1, r, g, b, 0.75 * strength);
        return [wash];
    }

    _onDestroy() {
        this._driver?.destroy();
        this._driver = null;
    }
});
