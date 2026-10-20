// SPDX-License-Identifier: GPL-3.0-or-later

//! Shape of the island and how it moves between modes.

use crate::spring::{Spring, SpringConfig};

/// Radius of the concave "shoulders" that join the island to the top edge.
pub const SHOULDER_RADIUS: f64 = 10.0;

/// The visible black shape, hanging down from the top edge of the screen.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IslandShape {
    pub width: f64,
    pub height: f64,
    /// Radius of the two bottom corners.
    pub radius: f64,
}

impl IslandShape {
    /// Horizontal bounds `(x, width)` of the shape, shoulders included, when
    /// centred on a canvas `canvas_width` wide.
    pub fn horizontal_bounds(&self, canvas_width: f64) -> (f64, f64) {
        let outer = self.width + 2.0 * SHOULDER_RADIUS;
        ((canvas_width - outer) / 2.0, outer)
    }

    /// How far the shape is between compact (0.0) and expanded (1.0), based
    /// on its height. Goes slightly outside that range while overshooting.
    pub fn expansion(&self) -> f64 {
        let compact = IslandMode::Compact.shape().height;
        let expanded = IslandMode::Expanded.shape().height;
        (self.height - compact) / (expanded - compact)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum IslandMode {
    /// Small pill showing glanceable info, e.g. the clock.
    #[default]
    Compact,
    /// Full panel shown while the pointer is over the island.
    Expanded,
}

impl IslandMode {
    pub const fn shape(self) -> IslandShape {
        match self {
            Self::Compact => IslandShape {
                width: 190.0,
                height: 36.0,
                radius: 14.0,
            },
            Self::Expanded => IslandShape {
                width: 560.0,
                height: 150.0,
                radius: 32.0,
            },
        }
    }

    /// The island uses the same spring in both directions.
    pub const fn spring(self) -> SpringConfig {
        SpringConfig::ISLAND
    }
}

/// Animates every dimension of an [`IslandShape`] with its own spring.
#[derive(Debug, Clone)]
pub struct IslandMotion {
    width: Spring,
    height: Spring,
    radius: Spring,
}

impl IslandMotion {
    pub fn new(mode: IslandMode) -> Self {
        let shape = mode.shape();
        let config = mode.spring();
        Self {
            width: Spring::new(shape.width, config),
            height: Spring::new(shape.height, config),
            radius: Spring::new(shape.radius, config),
        }
    }

    pub fn animate_to(&mut self, mode: IslandMode) {
        let shape = mode.shape();
        let config = mode.spring();
        self.width.set_target(shape.width, config);
        self.height.set_target(shape.height, config);
        self.radius.set_target(shape.radius, config);
    }

    /// Advances all springs by `dt` seconds; returns whether all are at rest.
    pub fn step(&mut self, dt: f64) -> bool {
        // Step every spring, even if an earlier one has settled.
        let width = self.width.step(dt);
        let height = self.height.step(dt);
        let radius = self.radius.step(dt);
        width && height && radius
    }

    pub fn current(&self) -> IslandShape {
        let width = self.width.value().max(0.0);
        let height = self.height.value().max(0.0);
        IslandShape {
            width,
            height,
            // A corner can never be larger than the shape that holds it.
            radius: self.radius.value().clamp(0.0, height.min(width / 2.0)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expansion_spans_zero_to_one() {
        assert_eq!(IslandMode::Compact.shape().expansion(), 0.0);
        assert_eq!(IslandMode::Expanded.shape().expansion(), 1.0);
    }

    #[test]
    fn motion_reaches_expanded_shape() {
        let mut motion = IslandMotion::new(IslandMode::Compact);
        motion.animate_to(IslandMode::Expanded);
        let settled = (0..600).any(|_| motion.step(1.0 / 60.0));
        assert!(settled);
        assert_eq!(motion.current(), IslandMode::Expanded.shape());
    }

    #[test]
    fn bounds_are_centred() {
        let shape = IslandMode::Compact.shape();
        let (x, width) = shape.horizontal_bounds(640.0);
        assert_eq!(x * 2.0 + width, 640.0);
    }
}
