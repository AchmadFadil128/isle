// SPDX-License-Identifier: GPL-3.0-or-later

// Damped springs drive every island animation: unlike fixed-duration easing, a spring can be
// retargeted mid-flight and keeps its velocity, so the island never jolts.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

/** The island's size spring: ~3.5% overshoot, peaking at ~0.37 s and at rest by ~0.57 s. */
export const ISLAND = {stiffness: 155, damping: 18};
/** Same speed without overshoot, for corner and shoulder radii. */
export const GENTLE = {stiffness: 155, damping: 25};

const MAX_STEP = 1 / 240;
const MAX_FRAME = 0.25;
/** At rest within a quarter pixel, slower than 2 px/s: closer is invisible, and creeping on would keep
 * nudging the island's edges by a pixel for a second more. */
const REST_DISTANCE = 0.25;
const REST_SPEED = 2;

export class Spring {
    constructor(value, config = ISLAND) {
        this.value = value;
        this.target = value;
        this.velocity = 0;
        this.config = config;
    }

    setTarget(target, config = this.config) {
        this.target = target;
        this.config = config;
    }

    /** Jumps straight to `value` with no motion. */
    reset(value) {
        this.value = this.target = value;
        this.velocity = 0;
    }

    get settled() {
        return Math.abs(this.value - this.target) < REST_DISTANCE &&
            Math.abs(this.velocity) < REST_SPEED;
    }

    /** Advances by `dt` seconds; returns whether the spring is at rest. */
    step(dt) {
        let remaining = Math.min(Math.max(dt, 0), MAX_FRAME);
        while (remaining > 0 && !this.settled) {
            const h = Math.min(remaining, MAX_STEP);
            const {stiffness, damping} = this.config;
            const acceleration = -stiffness * (this.value - this.target) - damping * this.velocity;
            this.velocity += acceleration * h;
            this.value += this.velocity * h;
            remaining -= h;
        }
        if (this.settled) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        return false;
    }
}

/** Steps springs once per frame of `actor`'s stage view, calling `onFrame` each step, until all rest. */
export class SpringDriver {
    constructor(actor, springs, onFrame) {
        this._springs = springs;
        this._onFrame = onFrame;
        this._lastFrame = 0;
        // A looping timeline is just a frame clock tied to the actor.
        this._timeline = new Clutter.Timeline({actor, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
    }

    /** Whether the springs are still moving. */
    get running() {
        return this._timeline?.is_playing() ?? false;
    }

    start() {
        if (this._timeline.is_playing())
            return;
        this._lastFrame = GLib.get_monotonic_time();
        this._timeline.start();
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        const dt = (now - this._lastFrame) / 1e6;
        this._lastFrame = now;

        let settled = true;
        for (const spring of this._springs)
            settled = spring.step(dt) && settled;
        this._onFrame();
        if (settled)
            this._timeline.stop();
    }

    destroy() {
        this._timeline.stop();
        this._timeline.run_dispose();
        this._timeline = null;
    }
}
