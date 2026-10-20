// SPDX-License-Identifier: GPL-3.0-or-later

//! The island widget: an animated black shape with content on top.
//!
//! The window never changes size. It is a fixed transparent canvas big enough
//! for the expanded island, and only the shape drawn inside it animates.
//! Resizing a Wayland surface every frame stutters; redrawing does not. The
//! input region follows the shape so clicks outside it reach the windows below.

mod shape;
mod view;

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
use std::time::Duration;

use gtk::{cairo, glib, prelude::*};
use gtk4 as gtk;
use isle_core::geometry::{IslandMode, IslandMotion, IslandShape};

use self::view::Views;

/// Size of the transparent window: the expanded island plus room for its
/// shoulders and spring overshoot.
pub const CANVAS_WIDTH: i32 = 640;
pub const CANVAS_HEIGHT: i32 = 180;

/// How long the pointer must rest on the island before it expands, so merely
/// passing over it does nothing.
const EXPAND_DELAY: Duration = Duration::from_millis(120);
/// Grace period before collapsing, forgiving a pointer that briefly slips off.
const COLLAPSE_DELAY: Duration = Duration::from_millis(250);

#[derive(Clone)]
pub struct Island(Rc<Inner>);

struct Inner {
    root: gtk::Overlay,
    canvas: gtk::DrawingArea,
    views: Views,
    mode: Cell<IslandMode>,
    motion: RefCell<IslandMotion>,
    animating: Cell<bool>,
    last_frame_us: Cell<Option<i64>>,
    pending_mode: RefCell<Option<glib::SourceId>>,
}

impl Island {
    pub fn new() -> Self {
        let canvas = gtk::DrawingArea::new();
        let views = Views::new();

        let root = gtk::Overlay::builder()
            .css_classes(["isle-island"])
            .child(&canvas)
            .build();
        root.add_overlay(&views.compact);
        root.add_overlay(&views.expanded);

        let mode = IslandMode::default();
        let island = Self(Rc::new(Inner {
            root,
            canvas,
            views,
            mode: Cell::new(mode),
            motion: RefCell::new(IslandMotion::new(mode)),
            animating: Cell::new(false),
            last_frame_us: Cell::new(None),
            pending_mode: RefCell::new(None),
        }));
        island.connect_signals();
        island.render();
        island
    }

    pub fn widget(&self) -> &gtk::Overlay {
        &self.0.root
    }

    /// Cancels pending work. Call when the island's window is destroyed.
    pub fn shutdown(&self) {
        self.cancel_pending_mode();
    }

    fn connect_signals(&self) {
        let inner = &self.0;

        let weak = self.downgrade();
        inner.canvas.set_draw_func(move |_, cr, width, _| {
            if let Some(island) = upgrade(&weak) {
                let shape = island.0.motion.borrow().current();
                shape::fill(cr, f64::from(width), &shape);
            }
        });

        let weak = self.downgrade();
        inner.root.connect_realize(move |_| {
            if let Some(island) = upgrade(&weak) {
                island.set_input_region(island.0.motion.borrow().current());
            }
        });

        let hover = gtk::EventControllerMotion::new();
        let weak = self.downgrade();
        hover.connect_enter(move |_, _, _| {
            if let Some(island) = upgrade(&weak) {
                island.set_mode_after(IslandMode::Expanded, EXPAND_DELAY);
            }
        });
        let weak = self.downgrade();
        hover.connect_leave(move |_| {
            if let Some(island) = upgrade(&weak) {
                island.set_mode_after(IslandMode::Compact, COLLAPSE_DELAY);
            }
        });
        inner.root.add_controller(hover);

        // Clicking expands immediately, without waiting for hover intent.
        let click = gtk::GestureClick::new();
        let weak = self.downgrade();
        click.connect_released(move |_, _, _, _| {
            if let Some(island) = upgrade(&weak) {
                island.set_mode(IslandMode::Expanded);
            }
        });
        inner.root.add_controller(click);
    }

    fn set_mode_after(&self, mode: IslandMode, delay: Duration) {
        self.cancel_pending_mode();
        let weak = self.downgrade();
        let source = glib::timeout_add_local_once(delay, move || {
            if let Some(island) = upgrade(&weak) {
                // The source has fired, so it must be forgotten, not removed.
                island.0.pending_mode.take();
                island.set_mode(mode);
            }
        });
        self.0.pending_mode.replace(Some(source));
    }

    fn cancel_pending_mode(&self) {
        if let Some(source) = self.0.pending_mode.take() {
            source.remove();
        }
    }

    fn set_mode(&self, mode: IslandMode) {
        self.cancel_pending_mode();
        if self.0.mode.replace(mode) == mode {
            return;
        }
        self.0.motion.borrow_mut().animate_to(mode);
        // Grow the input region up front so the pointer is not lost while the
        // shape is still catching up. Shrinking waits until the motion settles.
        if mode == IslandMode::Expanded {
            self.set_input_region(mode.shape());
        }
        self.start_animation();
    }

    fn start_animation(&self) {
        if self.0.animating.replace(true) {
            return;
        }
        self.0.last_frame_us.set(None);
        let weak = self.downgrade();
        self.0
            .canvas
            .add_tick_callback(move |_, clock| match upgrade(&weak) {
                Some(island) => island.on_frame(clock.frame_time()),
                None => glib::ControlFlow::Break,
            });
    }

    /// Runs once per display refresh while animating. Returning `Break` when
    /// the springs settle means the island uses no CPU while idle.
    fn on_frame(&self, frame_time_us: i64) -> glib::ControlFlow {
        let dt = self
            .0
            .last_frame_us
            .replace(Some(frame_time_us))
            .map_or(1.0 / 60.0, |previous| {
                (frame_time_us - previous) as f64 / 1e6
            });

        let settled = self.0.motion.borrow_mut().step(dt);
        self.render();

        if settled {
            self.0.animating.set(false);
            self.set_input_region(self.0.motion.borrow().current());
            glib::ControlFlow::Break
        } else {
            glib::ControlFlow::Continue
        }
    }

    fn render(&self) {
        let inner = &self.0;
        inner.canvas.queue_draw();

        // The compact content fades out early and the expanded content fades
        // in late, so the two never visibly overlap mid-transition.
        let expansion = inner.motion.borrow().current().expansion();
        inner
            .views
            .compact
            .set_opacity(1.0 - smoothstep(0.0, 0.35, expansion));
        inner
            .views
            .expanded
            .set_opacity(smoothstep(0.45, 1.0, expansion));
        inner.views.expanded.set_can_target(expansion > 0.5);
    }

    fn set_input_region(&self, shape: IslandShape) {
        let Some(surface) = self.0.root.native().and_then(|native| native.surface()) else {
            return;
        };
        let canvas_width = match self.0.canvas.width() {
            0 => CANVAS_WIDTH,
            width => width,
        };
        let (x, width) = shape.horizontal_bounds(f64::from(canvas_width));
        let rect = cairo::RectangleInt::new(
            x.floor() as i32,
            0,
            width.ceil() as i32 + 1,
            shape.height.ceil() as i32,
        );
        surface.set_input_region(Some(&cairo::Region::create_rectangle(&rect)));
    }

    fn downgrade(&self) -> Weak<Inner> {
        Rc::downgrade(&self.0)
    }
}

fn upgrade(weak: &Weak<Inner>) -> Option<Island> {
    weak.upgrade().map(Island)
}

/// Hermite smoothstep: 0 below `edge0`, 1 above `edge1`, smooth in between.
fn smoothstep(edge0: f64, edge1: f64, x: f64) -> f64 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
