//! Pixels: logical and physical, per monitor, and SendInput's absolute space.
//!
//! The helper runs per-monitor-DPI aware, so every rectangle it reports is in
//! physical pixels of the virtual desktop (the space UI Automation, capture
//! and `SendInput` agree on). A caller that thinks in a monitor's scaled
//! (logical) pixels converts with the monitor's own scale, never the primary's.

use crate::protocol::Rect;

/// A point in virtual-desktop physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// The dpi Windows calls 100%.
pub const BASE_DPI: u32 = 96;

/// 96 dpi is 1.0, 144 dpi is 1.5. A dpi of 0 (a failed query) counts as 96.
pub fn scale_from_dpi(dpi: u32) -> f64 {
    if dpi == 0 {
        1.0
    } else {
        f64::from(dpi) / f64::from(BASE_DPI)
    }
}

pub fn logical_to_physical(logical: f64, scale: f64) -> i32 {
    (logical * scale).round() as i32
}

pub fn physical_to_logical(physical: i32, scale: f64) -> f64 {
    f64::from(physical) / scale
}

impl Rect {
    pub fn right(&self) -> i32 {
        self.x + self.width
    }

    pub fn bottom(&self) -> i32 {
        self.y + self.height
    }

    /// Half-open: the left and top edges are inside, the right and bottom are not.
    pub fn contains(&self, p: Point) -> bool {
        p.x >= self.x && p.x < self.right() && p.y >= self.y && p.y < self.bottom()
    }

    pub fn center(&self) -> Point {
        Point {
            x: self.x + self.width / 2,
            y: self.y + self.height / 2,
        }
    }

    pub fn union(&self, other: &Rect) -> Rect {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        Rect {
            x,
            y,
            width: self.right().max(other.right()) - x,
            height: self.bottom().max(other.bottom()) - y,
        }
    }

    /// The same rectangle with each coordinate multiplied by `factor`, rounded.
    pub fn scaled(&self, factor: f64) -> Rect {
        let edge = |v: i32| (f64::from(v) * factor).round() as i32;
        let (x, y) = (edge(self.x), edge(self.y));
        Rect {
            x,
            y,
            width: edge(self.right()) - x,
            height: edge(self.bottom()) - y,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Monitor {
    pub id: String,
    /// Physical pixels of the virtual desktop.
    pub bounds: Rect,
    /// The monitor's effective dpi.
    pub dpi: u32,
}

impl Monitor {
    pub fn scale(&self) -> f64 {
        scale_from_dpi(self.dpi)
    }

    /// A physical point as logical pixels from this monitor's top-left corner.
    pub fn to_logical(&self, p: Point) -> (f64, f64) {
        let s = self.scale();
        (
            physical_to_logical(p.x - self.bounds.x, s),
            physical_to_logical(p.y - self.bounds.y, s),
        )
    }

    /// Logical pixels from this monitor's top-left corner as a physical point.
    pub fn to_physical(&self, logical: (f64, f64)) -> Point {
        let s = self.scale();
        Point {
            x: self.bounds.x + logical_to_physical(logical.0, s),
            y: self.bounds.y + logical_to_physical(logical.1, s),
        }
    }
}

/// The monitor a point is on.
pub fn monitor_at(monitors: &[Monitor], p: Point) -> Option<&Monitor> {
    monitors.iter().find(|m| m.bounds.contains(p))
}

fn distance_squared(r: &Rect, p: Point) -> i64 {
    let dx = i64::from((r.x - p.x).max(0).max(p.x - (r.right() - 1)));
    let dy = i64::from((r.y - p.y).max(0).max(p.y - (r.bottom() - 1)));
    dx * dx + dy * dy
}

/// The monitor a point is on, else the nearest one: a point just outside the
/// desktop (a window's edge) still has a monitor to be scaled by.
pub fn monitor_nearest(monitors: &[Monitor], p: Point) -> Option<&Monitor> {
    monitors
        .iter()
        .min_by_key(|m| distance_squared(&m.bounds, p))
}

/// The rectangle all monitors cover together.
pub fn virtual_bounds(monitors: &[Monitor]) -> Option<Rect> {
    monitors.iter().map(|m| m.bounds).reduce(|a, b| a.union(&b))
}

/// A point as `SendInput` wants it with `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`:
/// 0 to 65535 across the virtual desktop, clamped to it.
pub fn to_absolute(p: Point, virtual_desktop: &Rect) -> (i32, i32) {
    let axis = |v: i32, origin: i32, extent: i32| -> i32 {
        if extent <= 1 {
            return 0;
        }
        let t = f64::from(v - origin) / f64::from(extent - 1);
        (t * 65535.0).round().clamp(0.0, 65535.0) as i32
    };
    (
        axis(p.x, virtual_desktop.x, virtual_desktop.width),
        axis(p.y, virtual_desktop.y, virtual_desktop.height),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: i32, height: i32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn two() -> Vec<Monitor> {
        vec![
            Monitor {
                id: "left".into(),
                bounds: rect(-1920, 0, 1920, 1080),
                dpi: 96,
            },
            Monitor {
                id: "main".into(),
                bounds: rect(0, 0, 3840, 2160),
                dpi: 192,
            },
        ]
    }

    #[test]
    fn scale_follows_dpi() {
        assert_eq!(scale_from_dpi(96), 1.0);
        assert_eq!(scale_from_dpi(144), 1.5);
        assert_eq!(scale_from_dpi(0), 1.0);
    }

    #[test]
    fn a_point_is_scaled_by_its_own_monitor() {
        let m = two();
        let p = Point { x: 200, y: 100 };
        let mon = monitor_at(&m, p).unwrap();
        assert_eq!(mon.id, "main");
        assert_eq!(mon.to_logical(p), (100.0, 50.0));
        assert_eq!(mon.to_physical((100.0, 50.0)), p);
        let q = Point { x: -100, y: 40 };
        let mon = monitor_at(&m, q).unwrap();
        assert_eq!(mon.id, "left");
        assert_eq!(mon.to_logical(q), (1820.0, 40.0));
    }

    #[test]
    fn the_right_and_bottom_edges_belong_to_the_next_monitor() {
        let m = two();
        assert_eq!(monitor_at(&m, Point { x: -1, y: 0 }).unwrap().id, "left");
        assert_eq!(monitor_at(&m, Point { x: 0, y: 0 }).unwrap().id, "main");
        assert!(monitor_at(&m, Point { x: 0, y: 2160 }).is_none());
        assert_eq!(
            monitor_nearest(&m, Point { x: 0, y: 2160 }).unwrap().id,
            "main"
        );
        assert_eq!(
            monitor_nearest(&m, Point { x: -5000, y: 10 }).unwrap().id,
            "left"
        );
    }

    #[test]
    fn absolute_space_spans_the_virtual_desktop() {
        let m = two();
        let v = virtual_bounds(&m).unwrap();
        assert_eq!(v, rect(-1920, 0, 5760, 2160));
        assert_eq!(to_absolute(Point { x: -1920, y: 0 }, &v), (0, 0));
        assert_eq!(to_absolute(Point { x: 3839, y: 2159 }, &v), (65535, 65535));
        assert_eq!(to_absolute(Point { x: 9999, y: -9 }, &v), (65535, 0));
    }

    #[test]
    fn rect_math() {
        let r = rect(10, 20, 30, 40);
        assert_eq!(r.center(), Point { x: 25, y: 40 });
        assert_eq!(r.scaled(1.5), rect(15, 30, 45, 60));
        assert_eq!(r.union(&rect(0, 0, 5, 5)), rect(0, 0, 40, 60));
    }
}
