use std::f64::consts::{FRAC_PI_2, PI};

use gtk4::cairo;
use pulau_core::geometry::{IslandShape, SHOULDER_RADIUS};

/// Fills the island outline: a flat top joined to the screen edge by two
/// concave shoulders, and two rounded bottom corners.
///
/// ```text
///  ‿╮                  ╭‿    <- shoulders (concave)
///    │                │
///    ╰────────────────╯      <- bottom corners (convex)
/// ```
pub fn fill(cr: &cairo::Context, canvas_width: f64, shape: &IslandShape) {
    let (outer_x, _) = shape.horizontal_bounds(canvas_width);
    let s = SHOULDER_RADIUS.min(shape.height);
    let left = outer_x + SHOULDER_RADIUS;
    let right = left + shape.width;
    let bottom = shape.height;
    let r = shape.radius;

    cr.new_path();
    cr.arc(left - s, s, s, -FRAC_PI_2, 0.0);
    cr.arc_negative(left + r, bottom - r, r, PI, FRAC_PI_2);
    cr.arc_negative(right - r, bottom - r, r, FRAC_PI_2, 0.0);
    cr.arc(right + s, s, s, PI, PI + FRAC_PI_2);
    cr.close_path();

    cr.set_source_rgb(0.0, 0.0, 0.0);
    // Errors only occur when the cairo context is already broken.
    let _ = cr.fill();
}
