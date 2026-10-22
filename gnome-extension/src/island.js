// SPDX-License-Identifier: GPL-3.0-or-later

// The island itself: a black shape hanging from the top bar that springs between sizes and
// cross-fades views. On a bar that is not black it hangs from the screen's top edge, like a notch.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {GENTLE, Spring, SpringDriver} from './spring.js';
import {fence} from './widgets.js';


/** Sideways speed (px/s) `nudge` gives: a ~15 px stretch that springs back, as iOS does at a volume limit. */
const NUDGE_VELOCITY = 220;
/** How long a view takes to glide to its new place when its width changes. */
const GLIDE_MS = 360;
/** The shape layer reaches this far past the island on each side (see `_repaint`). */
const SHAPE_PAD = 1;
/** Where a view shown out of sight is moved (see `warmView`): far above the island, beyond its clip. */
const OUT_OF_REACH = -10000;

/** How long a tint takes to come and go: a wash, and a glow (which lingers out). */
const TINT_FADE = {wash: [450, 450], glow: [380, 1100], siri: [300, 500]};

/** The 'siri' glow is drawn at 1/this of the size and scaled up: it is soft, so it looks the same
 * with a quarter of the pixels to paint each frame. */
const GLOW_SCALE = 2;

/** Cross-fade timings in milliseconds. */
const FADE_OUT = 160;
const FADE_IN = 320;
/** The incoming view waits for the shape to make room before appearing. */
const FADE_IN_DELAY = 200;
/** Below this shoulder size (px) the corners may climb into the top bar, so the island rounds smoothly. */
const SHOULDER_FADE = 4;

export const Island = GObject.registerClass({
    Properties: {
        // How strongly `tint` washes the island, so it can fade in and out.
        'tint-strength': GObject.ParamSpec.double('tint-strength', null, null,
            GObject.ParamFlags.READWRITE, 0, 1, 0),
        // Like `hover`, without its :hover pseudo class: setting that restyles every view.
        'hovered': GObject.ParamSpec.boolean('hovered', null, null, GObject.ParamFlags.READABLE, false),
    },
    Signals: {'geometry-changed': {}},
}, class Island extends St.Widget {
    _init() {
        super._init({
            name: 'isleIsland',
            reactive: true,
            layout_manager: new Clutter.FixedLayout(),
        });

        /** Height of the top bar the island grows out of; 0 for none. */
        this._topInset = 0;
        this._hovered = false;
        this._monitor = null;
        this._view = null;
        this._views = [];
        this._tint = null;
        this._tintStyle = 'wash';
        this._tintStrength = 0;
        this._motion = {time: 0, level: 0};

        /** Where the island and its views' frame were last put, in whole pixels (see `_sync`). */
        this._islandX = 0;
        this._islandFraction = 0;
        this._stageX = 0;
        this._width = new Spring(0);
        this._height = new Spring(0);
        this._radius = new Spring(0, GENTLE);
        this._shoulder = new Spring(0, GENTLE);
        this._springs = [this._width, this._height, this._radius, this._shoulder];
        this._driver = new SpringDriver(this, this._springs, () => this._sync());

        this._shape = new St.DrawingArea();
        this._shape.connect('repaint', area => this._repaint(area));
        this.add_child(this._shape);
        // The moving 'siri' light, on a layer of its own: the shape below is only drawn when it changes.
        this._glow = new St.DrawingArea({visible: false});
        this._glow.set_pivot_point(0, 0);
        this._glow.set_scale(GLOW_SCALE, GLOW_SCALE);
        this._glow.connect('repaint', area => this._repaintGlow(area));
        this.add_child(this._glow);

        // Clips the views while the island grows; a fixed layout keeps them at
        // full size (a bin would squeeze them), so nothing reflows.
        this._stage = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: true,
        });
        this.add_child(this._stage);
        this._stageEnd = fence(this._stage);
        this.connect('destroy', () => this._onDestroy());
    }

    get hovered() {
        return this._hovered;
    }

    _setHovered(hovered) {
        if (hovered === this._hovered)
            return;
        this._hovered = hovered;
        this.notify('hovered');
    }

    vfunc_enter_event(event) {
        this._setHovered(true);
        return super.vfunc_enter_event(event);
    }

    vfunc_leave_event(event) {
        const related = event.get_related();
        if (!related || !this.contains(related))
            this._setHovered(false);
        return super.vfunc_leave_event(event);
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
        const siri = this._tintStyle === 'siri';
        this._glow.visible = siri && Boolean(this._tint) && value > 0;
        if (this._glow.visible)
            this._glow.queue_repaint();
        if (!siri)
            this._shape.queue_repaint();
    }

    // Colours the island with `rgb` (0..1; null fades it): 'wash' rises to the bottom, 'glow' spills
    // up from the two bottom corners, 'siri' (a list of colours) flows around the edge.
    setTint(rgb, style = 'wash') {
        if (rgb) {
            // The shape draws every style but the glow, so it changes when the style does.
            if (style !== this._tintStyle)
                this._shape.queue_repaint();
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

    /** Moves the 'siri' tint: `time` in seconds, `level` (0..1) swells it. */
    setTintMotion(time, level) {
        this._motion = {time, level};
        if (this._glow.visible)
            this._glow.queue_repaint();
    }

    /** Where `actor` in the shown view will be once the island settles: {x, y, width, height}. */
    restingRect(actor) {
        if (!this._monitor || !this._view)
            return null;
        // Views stay put on screen, centred on the monitor (see `_placeView`).
        const viewX = this._screenX(this._view);
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

    /** Animates to `size` ({width, height, radius, shoulder}) and shows `view`, already sized to fit. */
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
     * Shows `view` out of sight and out of the pointer's reach, or hides it again, while the island rests
     * closed: its next real showing finds its style and layout ready. Never the view on screen; false then.
     */
    warmView(view, shown) {
        if (view === this._view)
            return false;
        if (shown) {
            view.opacity = 0;
            view.translation_y = OUT_OF_REACH;
            view.show();
        } else {
            view.hide();
            view.translation_y = 0;
        }
        return true;
    }

    /** Whether the island is still changing shape. */
    get morphing() {
        return this._driver?.running ?? false;
    }

    /** Adds a view, hidden. All views are added up front so they are always on the stage. */
    addView(view) {
        view.connect('notify::width', () => this._onViewWidth(view));
        view.opacity = 0;
        // For good: toggling it would restyle the view's every child.
        view.reactive = true;
        view.hide();
        this._stage.insert_child_below(view, this._stageEnd);
        this._views.push(view);
    }

    /** A quick rubber-band stretch, e.g. pressing volume up at 100%. */
    nudge() {
        if (!St.Settings.get().enable_animations)
            return;
        this._width.velocity += NUDGE_VELOCITY;
        this._driver.start();
    }

    // A view that changes width moves its edges at once; the one shown glides there instead (FLIP: it is
    // put in its new place, offset back to where it was, and eased to none), as the shape springs after.
    _onViewWidth(view) {
        const before = this._monitor ? view.x + this._islandX + this._stageX : null;
        this._placeView(view);
        if (before === null || view !== this._view || !view.mapped || !St.Settings.get().enable_animations)
            return;
        const offset = view.translation_x + before - (view.x + this._islandX + this._stageX);
        if (offset === 0)
            return;
        view.remove_transition('translation-x');
        view.translation_x = offset;
        view.ease({translation_x: 0, duration: GLIDE_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }

    /** Where `view` sits on screen: centred on the monitor, in whole pixels. */
    _screenX(view) {
        return Math.round(this._monitor.x + (this._monitor.width - view.width) / 2);
    }

    // Centres `view` on the monitor, not on the island: as the island grows or shrinks around it, the
    // view stays still on screen, where two separate roundings would shake it by a pixel each frame.
    _placeView(view) {
        const x = this._monitor
            ? this._screenX(view) - this._islandX - this._stageX
            : Math.round((Math.ceil(Math.max(0, this._width.value)) - view.width) / 2);
        view.set_position(x, 0);
    }

    _showView(view) {
        if (view === this._view)
            return;

        const previous = this._view;
        if (previous) {
            previous.remove_all_transitions();
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
        // Still fading out (shown again within a moment): it comes back from where it is, without a blink.
        const returning = view.visible && view.opacity > 0;
        view.remove_all_transitions();
        view.translation_x = view.translation_y = 0;
        view.show();
        if (!returning)
            view.opacity = 0;
        view.ease({
            opacity: 255,
            delay: previous && !returning ? FADE_IN_DELAY : 0,
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
        // A pixel wider on each side, for the fraction the island is drawn off its whole-pixel place.
        this._shape.set_position(-SHAPE_PAD, 0);
        this._shape.set_size(Math.ceil(outerWidth) + 2 * SHAPE_PAD, Math.ceil(height));
        this._glow.set_size(Math.ceil(outerWidth / GLOW_SCALE), Math.ceil(height / GLOW_SCALE));
        // Whole pixels keep text sharp while the island resizes.
        this._stageX = Math.round(margin);
        this._stage.set_position(this._stageX, 0);
        this._stage.set_size(Math.ceil(width), Math.ceil(height));
        if (this._monitor) {
            const {x, y, width: monitorWidth} = this._monitor;
            const exact = x + (monitorWidth - outerWidth) / 2;
            this._islandX = Math.round(exact);
            this._islandFraction = exact - this._islandX;
            this.set_position(this._islandX, y);
        }
        for (const view of this._views)
            this._placeView(view);
        this._shape.queue_repaint();
        if (this._glow.visible)
            this._glow.queue_repaint();
        this.emit('geometry-changed');
    }

    _repaint(area) {
        const cr = area.get_context();
        // At the island's exact place (its actor sits on a whole pixel), so its edges never step back.
        cr.translate(SHAPE_PAD + this._islandFraction, 0);
        const height = Math.max(0, this._height.value);
        this._outline(cr, height);
        cr.setSourceRGBA(0, 0, 0, 1);
        cr.fillPreserve();
        if (this._tint && this._tintStrength > 0 && this._tintStyle !== 'siri') {
            const {left, right, top} = this._outlineBox;
            for (const gradient of this._tintGradients(left, right, top, height)) {
                cr.setSource(gradient);
                cr.fillPreserve();
            }
        }
        cr.newPath();
        cr.$dispose();
    }

    // The 'siri' light, inside the shape, on the scaled-down glow layer.
    _repaintGlow(area) {
        const cr = area.get_context();
        const height = Math.max(0, this._height.value);
        cr.scale(1 / GLOW_SCALE, 1 / GLOW_SCALE);
        cr.translate(this._islandFraction, 0);
        this._outline(cr, height);
        cr.clip();
        const {left, right, top, radius} = this._outlineBox;
        this._paintRim(cr, left, right, top, height, radius);
        cr.$dispose();
    }

    /** Traces the island's shape `height` tall into `cr`, and keeps its box in `_outlineBox`. */
    _outline(cr, height) {
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
        this._outlineBox = {left, right, top, radius};
    }

    // Light from the edge inside the shape, as Siri's: brightest along the bottom and fading up the
    // sides, its colours flowing; it swells and brightens with `level` (the voice).
    _paintRim(cr, left, right, top, height, radius) {
        const {time, level} = this._motion;
        const strength = this._tintStrength;
        const r = Math.max(0, radius);
        const sides = () => {
            cr.moveTo(left, top);
            cr.lineTo(left, height - r);
            cr.arcNegative(left + r, height - r, r, Math.PI, Math.PI / 2);
            cr.lineTo(right - r, height);
            cr.arcNegative(right - r, height - r, r, Math.PI / 2, 0);
            cr.lineTo(right, top);
        };
        cr.pushGroup();
        cr.setOperator(Cairo.Operator.ADD);
        // Faint strokes, each narrower, so the edge glows softly inwards.
        const STEPS = 3;
        cr.setSource(this._flow(left, right, time, (0.09 + 0.07 * level) * strength));
        for (let i = 0; i < STEPS; i++) {
            cr.setLineWidth((20 + 14 * level) * (1 - i / STEPS));
            sides();
            cr.stroke();
        }
        // A thin haze along the bottom, deeper as it swells: light, not shapes.
        const rise = Math.min(46, Math.max(0, height - top) * 0.45) * (0.75 + 0.45 * level);
        const haze = new Cairo.LinearGradient(0, height - rise, 0, height);
        haze.addColorStopRGBA(0, 0, 0, 0, 0);
        haze.addColorStopRGBA(1, 0, 0, 0, 1);
        cr.setSource(this._flow(left, right, time * 0.8 + 2, (0.3 + 0.2 * level) * strength, true));
        cr.mask(haze);
        // A crisp line of light at the very edge.
        cr.setSource(this._flow(left, right, time * 1.4, (0.42 + 0.25 * level) * strength, true));
        cr.setLineWidth(2.5);
        sides();
        cr.stroke();
        cr.popGroupToSource();
        // Rising from the bottom: gone by the top of the sides.
        const rising = new Cairo.LinearGradient(0, top, 0, height);
        rising.addColorStopRGBA(0, 0, 0, 0, 0);
        rising.addColorStopRGBA(0.55, 0, 0, 0, 0.35);
        rising.addColorStopRGBA(1, 0, 0, 0, 1);
        cr.setOperator(Cairo.Operator.OVER);
        cr.mask(rising);
    }

    /** A left-to-right gradient of the tint's colours, shifted by `time` so they flow. */
    _flow(left, right, time, alpha, shimmer = false) {
        const colors = this._tint;
        const gradient = new Cairo.LinearGradient(left, 0, right, 0);
        const STOPS = 24;
        for (let i = 0; i <= STOPS; i++) {
            const at = (i / STOPS + time * 0.12) * colors.length;
            const index = Math.floor(at);
            const mix = at - index;
            const [r1, g1, b1] = colors[index % colors.length];
            const [r2, g2, b2] = colors[(index + 1) % colors.length];
            // A slow swell of brightness travelling along, so the light moves, not only its hue.
            const swell = shimmer ? 0.7 + 0.3 * Math.sin((i / STOPS) * 2 * Math.PI * 1.5 - time * 1.6) : 1;
            gradient.addColorStopRGBA(i / STOPS, r1 + (r2 - r1) * mix, g1 + (g2 - g1) * mix,
                b1 + (b2 - b1) * mix, alpha * swell);
        }
        return gradient;
    }

    /** The gradients that paint the tint over the black shape, in order. */
    _tintGradients(left, right, top, height) {
        const strength = this._tintStrength;
        const [r, g, b] = this._tint;
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
