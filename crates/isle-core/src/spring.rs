// SPDX-License-Identifier: GPL-3.0-or-later

//! A damped harmonic spring, the motion primitive behind every island animation.
//!
//! Springs are used instead of fixed-duration easing curves because they can be
//! retargeted mid-flight without a visible jolt: the current velocity carries
//! over, which is what makes the island feel physical when the pointer moves
//! in and out quickly.

/// Stiffness and damping of a spring with unit mass.
///
/// Critical damping is `2 * sqrt(stiffness)`. Below it the spring overshoots
/// its target before settling; at or above it, it does not.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpringConfig {
    pub stiffness: f64,
    pub damping: f64,
}

impl SpringConfig {
    /// The island's size spring: ~3.5% overshoot, peaking after ~0.37 s
    /// (close to `cubic-bezier(.34, 1.32, .5, 1)` over 0.62 s).
    pub const ISLAND: Self = Self {
        stiffness: 155.0,
        damping: 18.0,
    };

    /// Same speed without overshoot, for radii.
    pub const GENTLE: Self = Self {
        stiffness: 155.0,
        damping: 25.0,
    };
}

/// Largest integration step, in seconds. Frames longer than this are split
/// into several steps so the simulation stays stable on slow or dropped frames.
const MAX_STEP: f64 = 1.0 / 240.0;

/// Frames longer than this (e.g. after a suspend) are treated as this long.
const MAX_FRAME: f64 = 0.25;

/// Distance and speed below which the spring is considered at rest.
const REST_DISTANCE: f64 = 0.05;
const REST_SPEED: f64 = 0.05;

#[derive(Debug, Clone, PartialEq)]
pub struct Spring {
    value: f64,
    velocity: f64,
    target: f64,
    config: SpringConfig,
}

impl Spring {
    /// Creates a spring resting at `value`.
    pub fn new(value: f64, config: SpringConfig) -> Self {
        Self {
            value,
            velocity: 0.0,
            target: value,
            config,
        }
    }

    pub fn value(&self) -> f64 {
        self.value
    }

    pub fn target(&self) -> f64 {
        self.target
    }

    /// Moves the target, keeping the current velocity.
    pub fn set_target(&mut self, target: f64, config: SpringConfig) {
        self.target = target;
        self.config = config;
    }

    pub fn is_settled(&self) -> bool {
        (self.value - self.target).abs() < REST_DISTANCE && self.velocity.abs() < REST_SPEED
    }

    /// Advances the simulation by `dt` seconds and returns whether the spring
    /// has come to rest. A resting spring snaps exactly onto its target.
    pub fn step(&mut self, dt: f64) -> bool {
        let mut remaining = dt.clamp(0.0, MAX_FRAME);
        while remaining > 0.0 && !self.is_settled() {
            let h = remaining.min(MAX_STEP);
            let SpringConfig { stiffness, damping } = self.config;
            let acceleration = -stiffness * (self.value - self.target) - damping * self.velocity;
            // Semi-implicit Euler: update velocity first, then position.
            self.velocity += acceleration * h;
            self.value += self.velocity * h;
            remaining -= h;
        }

        let settled = self.is_settled();
        if settled {
            self.value = self.target;
            self.velocity = 0.0;
        }
        settled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Steps at 60 fps until the spring rests, returning the peak value seen.
    fn run_to_rest(spring: &mut Spring) -> f64 {
        let mut peak = spring.value();
        for _ in 0..600 {
            if spring.step(1.0 / 60.0) {
                return peak;
            }
            peak = peak.max(spring.value());
        }
        panic!("spring did not settle within 10 seconds: {spring:?}");
    }

    #[test]
    fn settles_exactly_on_target() {
        let mut spring = Spring::new(0.0, SpringConfig::GENTLE);
        spring.set_target(100.0, SpringConfig::GENTLE);
        run_to_rest(&mut spring);
        assert_eq!(spring.value(), 100.0);
    }

    #[test]
    fn island_overshoots_and_gentle_does_not() {
        let mut island = Spring::new(0.0, SpringConfig::ISLAND);
        island.set_target(100.0, SpringConfig::ISLAND);
        assert!(run_to_rest(&mut island) > 100.5);

        let mut gentle = Spring::new(0.0, SpringConfig::GENTLE);
        gentle.set_target(100.0, SpringConfig::GENTLE);
        assert!(run_to_rest(&mut gentle) <= 100.0 + REST_DISTANCE);
    }

    #[test]
    fn retargeting_keeps_velocity() {
        let mut spring = Spring::new(0.0, SpringConfig::ISLAND);
        spring.set_target(100.0, SpringConfig::ISLAND);
        spring.step(0.05);
        let before = spring.velocity;
        spring.set_target(0.0, SpringConfig::ISLAND);
        assert_eq!(spring.velocity, before);
    }

    #[test]
    fn huge_frame_gap_stays_finite() {
        let mut spring = Spring::new(0.0, SpringConfig::ISLAND);
        spring.set_target(500.0, SpringConfig::ISLAND);
        spring.step(30.0);
        assert!(spring.value().is_finite());
    }
}
