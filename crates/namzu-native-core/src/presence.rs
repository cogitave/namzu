//! The presence overlay: the agent's own cursor and a frame round the window
//! it operates, so a person can see that something is working there.
//!
//! This file holds everything that is not a window: the wire shapes, the
//! motion (the numbers and formulas of `presence/motion.ts`, which the
//! TypeScript tests pin), a small state machine that says what to draw at a
//! given time, and a software renderer that fills a premultiplied BGRA
//! bitmap. The overlay windows themselves (layered, click-through, never
//! activated) are in the `namzu-native` crate.
//!
//! The overlay is not hidden from screen capture. A screenshot may show it,
//! which is honest: the picture shows where the agent pointed.

use crate::dpi::Point;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceKind {
    Click,
    Type,
    Move,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceActRequest {
    /// The window being operated.
    pub window_id: String,
    pub kind: PresenceKind,
    /// Where the action lands, in virtual-desktop pixels. Absent for typing,
    /// which stays where the cursor already is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<Point>,
}

/// The two overlay windows, by handle, once they exist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceActReply {
    pub cursor_window: u64,
    pub frame_window: u64,
}

// ---------------------------------------------------------------------------
// Motion (mirrors packages/computer-use/src/presence/motion.ts)
// ---------------------------------------------------------------------------

pub const GLIDE_MIN_MS: f64 = 140.0;
pub const GLIDE_MAX_MS: f64 = 420.0;
pub const GLIDE_MS_PER_PX: f64 = 0.45;
pub const GLIDE_BOW: f64 = 0.1;
pub const APPEAR_MS: f64 = 160.0;
pub const APPEAR_FROM_SCALE: f64 = 0.85;
pub const HOLD_MS: f64 = 2_000.0;
pub const FADE_MS: f64 = 500.0;
pub const DIP_SCALE: f64 = 0.88;
pub const DIP_DOWN_MS: f64 = 70.0;
pub const DIP_UP_MS: f64 = 110.0;
pub const RIPPLE_MS: f64 = 420.0;
pub const FRAME_PULSE_MS: f64 = 2_400.0;
pub const FRAME_PULSE_DEPTH: f64 = 0.08;

#[derive(Debug, Clone, Copy)]
pub struct RippleSpec {
    pub from: f64,
    pub to: f64,
    pub alpha: f64,
    pub stroke: f64,
}
pub const CLICK_RIPPLE: RippleSpec = RippleSpec {
    from: 5.0,
    to: 26.0,
    alpha: 0.55,
    stroke: 2.0,
};
pub const KEY_RIPPLE: RippleSpec = RippleSpec {
    from: 4.0,
    to: 14.0,
    alpha: 0.35,
    stroke: 1.5,
};

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

pub fn ease_in_out(u: f64) -> f64 {
    let t = clamp(u, 0.0, 1.0);
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
    }
}

pub fn ease_out(u: f64) -> f64 {
    1.0 - (1.0 - clamp(u, 0.0, 1.0)).powi(3)
}

/// How long a glide over `logical_distance` pixels takes, whole ms.
pub fn glide_duration_ms(logical_distance: f64) -> f64 {
    clamp(
        GLIDE_MIN_MS + logical_distance * GLIDE_MS_PER_PX,
        GLIDE_MIN_MS,
        GLIDE_MAX_MS,
    )
    .round()
}

/// The control point of the glide's curve: the middle of the path moved
/// sideways by [`GLIDE_BOW`] of its length, to the same side of the line
/// whichever way it is travelled.
pub fn glide_control(from: (f64, f64), to: (f64, f64)) -> (f64, f64) {
    let (dx, dy) = (to.0 - from.0, to.1 - from.1);
    let len = dx.hypot(dy);
    let mid = ((from.0 + to.0) / 2.0, (from.1 + to.1) / 2.0);
    if len < 1e-9 {
        return mid;
    }
    let (mut nx, mut ny) = (-dy / len, dx / len);
    if ny > 1e-9 || (ny.abs() <= 1e-9 && nx < 0.0) {
        nx = -nx;
        ny = -ny;
    }
    (mid.0 + nx * len * GLIDE_BOW, mid.1 + ny * len * GLIDE_BOW)
}

pub fn glide_point(from: (f64, f64), c: (f64, f64), to: (f64, f64), t: f64) -> (f64, f64) {
    let b = 1.0 - t;
    (
        b * b * from.0 + 2.0 * b * t * c.0 + t * t * to.0,
        b * b * from.1 + 2.0 * b * t * c.1 + t * t * to.1,
    )
}

pub fn dip_scale(ms: f64) -> f64 {
    if !(0.0..DIP_DOWN_MS + DIP_UP_MS).contains(&ms) {
        return 1.0;
    }
    if ms < DIP_DOWN_MS {
        1.0 - (1.0 - DIP_SCALE) * ease_out(ms / DIP_DOWN_MS)
    } else {
        DIP_SCALE + (1.0 - DIP_SCALE) * ease_out((ms - DIP_DOWN_MS) / DIP_UP_MS)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RippleFrame {
    /// Logical pixels from the tip.
    pub radius: f64,
    pub alpha: f64,
    pub stroke: f64,
}

pub fn ripple_frame(kind: PresenceKind, ms: f64) -> Option<RippleFrame> {
    if !(0.0..RIPPLE_MS).contains(&ms) {
        return None;
    }
    let spec = match kind {
        PresenceKind::Click => CLICK_RIPPLE,
        PresenceKind::Type => KEY_RIPPLE,
        PresenceKind::Move => return None,
    };
    let p = ms / RIPPLE_MS;
    Some(RippleFrame {
        radius: spec.from + (spec.to - spec.from) * ease_out(p),
        alpha: spec.alpha * (1.0 - p),
        stroke: spec.stroke,
    })
}

pub fn frame_pulse(ms: f64) -> f64 {
    1.0 - FRAME_PULSE_DEPTH
        + FRAME_PULSE_DEPTH * (2.0 * std::f64::consts::PI * ms / FRAME_PULSE_MS).sin()
}

pub fn idle_alpha(ms_since_last_action: f64) -> f64 {
    if ms_since_last_action <= HOLD_MS {
        1.0
    } else {
        clamp(1.0 - (ms_since_last_action - HOLD_MS) / FADE_MS, 0.0, 1.0)
    }
}

// ---------------------------------------------------------------------------
// What to draw at a time
// ---------------------------------------------------------------------------

/// What the cursor window shows now.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CursorFrame {
    /// The tip, in virtual-desktop pixels.
    pub tip: (f64, f64),
    /// Multiplies the sprite's size: the click dip and the first appearance.
    pub size: f64,
    /// 0..1 for the whole window.
    pub alpha: f64,
    pub ripple: Option<RippleFrame>,
}

/// What both windows show now.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scene {
    /// Absent until the cursor has a place (a first action that only typed has none).
    pub cursor: Option<CursorFrame>,
    /// 0..1 for the frame window.
    pub frame_alpha: f64,
}

/// The overlay's motion: where the cursor is going, when it left, when it last
/// acted. Pure; time comes in as milliseconds on any steady clock.
#[derive(Debug, Clone)]
pub struct Animator {
    from: (f64, f64),
    to: (f64, f64),
    glide_at: f64,
    glide_ms: f64,
    placed: bool,
    appear_at: f64,
    press_at: f64,
    press_kind: Option<PresenceKind>,
    /// When the last action landed; the hold starts here.
    hold_from: f64,
    shown: bool,
    pulse_from: f64,
}

impl Default for Animator {
    fn default() -> Self {
        Animator::new()
    }
}

impl Animator {
    pub fn new() -> Animator {
        Animator {
            from: (0.0, 0.0),
            to: (0.0, 0.0),
            glide_at: 0.0,
            glide_ms: 0.0,
            placed: false,
            appear_at: 0.0,
            press_at: f64::NEG_INFINITY,
            press_kind: None,
            hold_from: 0.0,
            shown: false,
            pulse_from: 0.0,
        }
    }

    /// An action starts at `now`. `scale` is the operated window's display scale.
    pub fn act(&mut self, now: f64, kind: PresenceKind, at: Option<(f64, f64)>, scale: f64) {
        if !self.shown {
            self.shown = true;
            self.appear_at = now;
            self.pulse_from = now;
        }
        if let Some(to) = at {
            let here = self.position(now);
            match here {
                Some(from) => {
                    let logical = (to.0 - from.0).hypot(to.1 - from.1) / scale.max(0.01);
                    self.from = from;
                    self.glide_ms = glide_duration_ms(logical);
                }
                None => {
                    self.from = to;
                    self.glide_ms = 0.0;
                }
            }
            self.to = to;
            self.glide_at = now;
            self.placed = true;
        }
        let lands = now + if at.is_some() { self.glide_ms } else { 0.0 };
        self.press_kind = match kind {
            PresenceKind::Move => None,
            k => Some(k),
        };
        self.press_at = lands;
        self.hold_from = lands;
    }

    pub fn hide(&mut self) {
        self.shown = false;
        self.placed = false;
        self.press_kind = None;
    }

    pub fn shown(&self) -> bool {
        self.shown
    }

    fn position(&self, now: f64) -> Option<(f64, f64)> {
        if !self.placed {
            return None;
        }
        if self.glide_ms <= 0.0 {
            return Some(self.to);
        }
        let u = (now - self.glide_at) / self.glide_ms;
        if u >= 1.0 {
            return Some(self.to);
        }
        let c = glide_control(self.from, self.to);
        Some(glide_point(self.from, c, self.to, ease_in_out(u)))
    }

    /// What to draw at `now`; `None` when nothing is shown (never acted, hidden, or faded out).
    pub fn scene(&self, now: f64) -> Option<Scene> {
        if !self.shown {
            return None;
        }
        let idle = idle_alpha(now - self.hold_from);
        if idle <= 0.0 {
            return None;
        }
        let appear = ease_out((now - self.appear_at) / APPEAR_MS);
        let alpha = idle * appear.max(0.0);
        let cursor = self.position(now).map(|tip| {
            let since_press = now - self.press_at;
            CursorFrame {
                tip,
                size: dip_scale(since_press)
                    * (APPEAR_FROM_SCALE + (1.0 - APPEAR_FROM_SCALE) * appear),
                alpha,
                ripple: self.press_kind.and_then(|k| ripple_frame(k, since_press)),
            }
        });
        Some(Scene {
            cursor,
            frame_alpha: (idle * appear * frame_pulse(now - self.pulse_from)).clamp(0.0, 1.0),
        })
    }

    /// Something is still moving, so the window should be redrawn every tick.
    pub fn busy(&self, now: f64) -> bool {
        self.shown
            && (now - self.appear_at < APPEAR_MS
                || now - self.glide_at < self.glide_ms
                || (now - self.press_at < RIPPLE_MS && now >= self.press_at - 1.0)
                || now - self.hold_from > HOLD_MS)
    }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/// Logical pixels from the tip to the edge of the cursor window.
pub const PAD: f64 = 32.0;

const ACCENT: [f32; 3] = [
    0x34 as f32 / 255.0,
    0xd3 as f32 / 255.0,
    0x69 as f32 / 255.0,
];
const OUTLINE: [f32; 3] = [0.04, 0.12, 0.07];
const SHADOW_DX: f64 = 1.5;
const SHADOW_DY: f64 = 2.5;
const SHADOW_BLUR: f64 = 4.0;
const SHADOW_A: f32 = 0.32;
const OUTLINE_W: f64 = 1.25;
const FRAME_STROKE: f64 = 2.0;
const FRAME_GLOW: f64 = 8.0;
const FRAME_RADIUS: f64 = 8.0;
const FRAME_STROKE_A: f32 = 0.65;
const FRAME_GLOW_A: f32 = 0.30;

/// The arrow, tip at the origin, y down.
const ARROW: [(f64, f64); 7] = [
    (0.0, 0.0),
    (0.0, 18.8),
    (4.5, 15.2),
    (7.7, 21.6),
    (11.2, 20.1),
    (8.0, 15.2),
    (14.0, 15.2),
];

/// A bitmap of premultiplied BGRA pixels, top row first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bitmap {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

impl Bitmap {
    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * self.width + x) * 4) as usize;
        [
            self.bgra[i],
            self.bgra[i + 1],
            self.bgra[i + 2],
            self.bgra[i + 3],
        ]
    }
}

fn seg_dist(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (abx, aby) = (b.0 - a.0, b.1 - a.1);
    let len2 = abx * abx + aby * aby;
    let t = if len2 == 0.0 {
        0.0
    } else {
        (((p.0 - a.0) * abx + (p.1 - a.1) * aby) / len2).clamp(0.0, 1.0)
    };
    (p.0 - (a.0 + abx * t)).hypot(p.1 - (a.1 + aby * t))
}

/// Signed distance from `p` to the arrow scaled by `s` (negative inside), in pixels.
fn arrow_sd(p: (f64, f64), s: f64) -> f64 {
    let pts: Vec<(f64, f64)> = ARROW.iter().map(|(x, y)| (x * s, y * s)).collect();
    let mut dist = f64::MAX;
    let mut inside = false;
    for i in 0..pts.len() {
        let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
        dist = dist.min(seg_dist(p, a, b));
        if (a.1 > p.1) != (b.1 > p.1) && p.0 < (b.0 - a.0) * (p.1 - a.1) / (b.1 - a.1) + a.0 {
            inside = !inside;
        }
    }
    if inside { -dist } else { dist }
}

/// Source-over of `color` at `alpha` onto a premultiplied pixel.
fn over(px: &mut [f32; 4], color: [f32; 3], alpha: f32) {
    let a = alpha.clamp(0.0, 1.0);
    let k = 1.0 - a;
    px[0] = color[0] * a + px[0] * k;
    px[1] = color[1] * a + px[1] * k;
    px[2] = color[2] * a + px[2] * k;
    px[3] = a + px[3] * k;
}

fn to_bgra(px: [f32; 4], out: &mut [u8]) {
    let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
    out[0] = q(px[2]).min(q(px[3]));
    out[1] = q(px[1]).min(q(px[3]));
    out[2] = q(px[0]).min(q(px[3]));
    out[3] = q(px[3]);
}

/// The side of the cursor window for a display scale (square, tip at the middle).
pub fn cursor_window_size(scale: f64) -> u32 {
    let side = (2.0 * PAD * scale).ceil() as u32;
    side + (side % 2)
}

/// Draws the cursor window: shadow, arrow, outline and the ripple, tip at the middle.
pub fn render_cursor(scale: f64, size: f64, ripple: Option<RippleFrame>) -> Bitmap {
    let side = cursor_window_size(scale);
    let tip = (f64::from(side) / 2.0, f64::from(side) / 2.0);
    let s = scale * size;
    let mut bgra = vec![0u8; (side * side * 4) as usize];
    for y in 0..side {
        for x in 0..side {
            let p = (f64::from(x) + 0.5 - tip.0, f64::from(y) + 0.5 - tip.1);
            let mut px = [0.0f32; 4];
            // Shadow: the arrow shifted and softened.
            let sd = arrow_sd((p.0 - SHADOW_DX * s, p.1 - SHADOW_DY * s), s);
            let soft = SHADOW_BLUR * s;
            let sh = (0.5 - sd / soft).clamp(0.0, 1.0) as f32;
            if sh > 0.0 {
                over(&mut px, [0.0, 0.0, 0.0], SHADOW_A * sh);
            }
            if let Some(r) = ripple {
                let radius = r.radius * scale;
                let d = (p.0.hypot(p.1) - radius).abs();
                let half = r.stroke * scale / 2.0;
                let cov = (0.5 - (d - half)).clamp(0.0, 1.0) as f32;
                if cov > 0.0 {
                    over(&mut px, ACCENT, cov * r.alpha as f32);
                }
            }
            let sd = arrow_sd(p, s);
            let fill = (0.5 - sd).clamp(0.0, 1.0) as f32;
            if fill > 0.0 {
                over(&mut px, ACCENT, fill);
            }
            let ring = (0.5 - (sd.abs() - OUTLINE_W * s / 2.0)).clamp(0.0, 1.0) as f32;
            if ring > 0.0 {
                over(&mut px, OUTLINE, ring * 0.9);
            }
            let i = ((y * side + x) * 4) as usize;
            to_bgra(px, &mut bgra[i..i + 4]);
        }
    }
    Bitmap {
        width: side,
        height: side,
        bgra,
    }
}

fn rounded_rect_sd(p: (f64, f64), half: (f64, f64), r: f64) -> f64 {
    let q = (p.0.abs() - (half.0 - r), p.1.abs() - (half.1 - r));
    q.0.max(0.0).hypot(q.1.max(0.0)) + q.0.max(q.1).min(0.0) - r
}

/// Draws the frame for a window of `width` by `height` physical pixels: a
/// green stroke along the inside edge and a soft glow inward from it.
pub fn render_frame(width: u32, height: u32, scale: f64) -> Bitmap {
    let mut bgra = vec![0u8; (width as usize) * (height as usize) * 4];
    let half = (f64::from(width) / 2.0, f64::from(height) / 2.0);
    let radius = (FRAME_RADIUS * scale).min(half.0.min(half.1));
    let stroke = FRAME_STROKE * scale;
    let glow = FRAME_GLOW * scale;
    let reach = stroke + glow;
    for y in 0..height {
        for x in 0..width {
            // Pixels deep inside stay clear; test the cheap bound first.
            let edge = f64::from(x)
                .min(f64::from(width - 1 - x))
                .min(f64::from(y))
                .min(f64::from(height - 1 - y));
            if edge > reach + radius {
                continue;
            }
            let p = (f64::from(x) + 0.5 - half.0, f64::from(y) + 0.5 - half.1);
            let sd = rounded_rect_sd(p, half, radius);
            let depth = -sd;
            let mut px = [0.0f32; 4];
            if (0.0..glow + stroke).contains(&(depth - stroke / 2.0)) && depth > stroke / 2.0 {
                let g = (1.0 - (depth - stroke) / glow).clamp(0.0, 1.0) as f32;
                over(&mut px, ACCENT, FRAME_GLOW_A * g * g);
            }
            let cov = (0.5 - ((depth - stroke / 2.0).abs() - stroke / 2.0)).clamp(0.0, 1.0) as f32;
            if cov > 0.0 {
                over(&mut px, ACCENT, FRAME_STROKE_A * cov);
            }
            if px[3] > 0.0 {
                let i = ((y * width + x) * 4) as usize;
                to_bgra(px, &mut bgra[i..i + 4]);
            }
        }
    }
    Bitmap {
        width,
        height,
        bgra,
    }
}

/// The 0..255 constant alpha the layered window is updated with.
pub fn constant_alpha(alpha: f64) -> u8 {
    (clamp(alpha, 0.0, 1.0) * 255.0).round() as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn glide_duration_follows_distance_and_clamps() {
        assert!(near(glide_duration_ms(0.0), 140.0));
        assert!(near(glide_duration_ms(200.0), 230.0));
        assert!(near(glide_duration_ms(5_000.0), 420.0));
    }

    #[test]
    fn the_glide_bows_to_one_side_both_ways() {
        let a = (0.0, 0.0);
        let b = (100.0, 0.0);
        let there = glide_control(a, b);
        let back = glide_control(b, a);
        assert!(near(there.0, back.0) && near(there.1, back.1));
        assert!(there.1 < 0.0, "up on the screen");
        let v = glide_control((0.0, 0.0), (0.0, 100.0));
        assert!(v.0 > 0.0, "right for a vertical line");
    }

    #[test]
    fn dip_ripple_and_idle_follow_the_script() {
        assert!(near(dip_scale(-1.0), 1.0) && near(dip_scale(180.0), 1.0));
        assert!(dip_scale(70.0) < 0.881);
        assert!(ripple_frame(PresenceKind::Click, -1.0).is_none());
        assert!(ripple_frame(PresenceKind::Move, 10.0).is_none());
        let r = ripple_frame(PresenceKind::Type, 0.0).unwrap();
        assert!(near(r.radius, 4.0) && near(r.alpha, 0.35));
        assert!(near(idle_alpha(2_000.0), 1.0) && near(idle_alpha(2_250.0), 0.5));
        assert!(near(idle_alpha(9_000.0), 0.0));
        assert!(frame_pulse(0.0) < 1.0 && frame_pulse(600.0) <= 1.0);
    }

    #[test]
    fn the_first_action_appears_in_place_and_later_ones_glide() {
        let mut a = Animator::new();
        assert!(a.scene(0.0).is_none());
        a.act(0.0, PresenceKind::Click, Some((100.0, 100.0)), 1.0);
        let s = a.scene(0.0).unwrap();
        assert_eq!(s.cursor.unwrap().tip, (100.0, 100.0));
        assert!(s.cursor.unwrap().alpha < 0.01, "fading in");
        let s = a.scene(500.0).unwrap();
        assert!(near(s.cursor.unwrap().alpha, 1.0));
        a.act(600.0, PresenceKind::Move, Some((400.0, 100.0)), 1.0);
        let mid = a.scene(600.0 + 100.0).unwrap().cursor.unwrap().tip;
        assert!(mid.0 > 100.0 && mid.0 < 400.0, "in flight at {mid:?}");
        let end = a.scene(600.0 + 1_000.0).unwrap().cursor.unwrap().tip;
        assert_eq!(end, (400.0, 100.0));
    }

    #[test]
    fn typing_without_a_place_shows_the_frame_only_and_holds_then_fades() {
        let mut a = Animator::new();
        a.act(0.0, PresenceKind::Type, None, 1.0);
        let s = a.scene(300.0).unwrap();
        assert!(s.cursor.is_none());
        assert!(s.frame_alpha > 0.5);
        assert!(a.scene(2_000.0 + 600.0).is_none(), "faded out");
        assert!(!a.busy(300.0 + 4_000.0) || a.scene(4_300.0).is_none());
    }

    #[test]
    fn hide_clears_everything() {
        let mut a = Animator::new();
        a.act(0.0, PresenceKind::Click, Some((1.0, 1.0)), 1.0);
        a.hide();
        assert!(a.scene(10.0).is_none() && !a.shown());
        a.act(20.0, PresenceKind::Click, Some((5.0, 5.0)), 1.0);
        assert_eq!(a.scene(400.0).unwrap().cursor.unwrap().tip, (5.0, 5.0));
    }

    fn premultiplied_ok(b: &Bitmap) -> bool {
        b.bgra
            .chunks_exact(4)
            .all(|p| p[0] <= p[3] && p[1] <= p[3] && p[2] <= p[3])
    }

    #[test]
    fn the_cursor_draws_an_opaque_green_tip_and_clear_corners() {
        let b = render_cursor(1.0, 1.0, None);
        assert_eq!((b.width, b.height), (64, 64));
        assert!(premultiplied_ok(&b));
        // Just inside the arrow's body below the tip.
        let body = b.pixel(32 + 2, 32 + 8);
        assert_eq!(body[3], 255, "opaque inside the arrow");
        assert!(body[1] > body[2] && body[1] > body[0], "green: {body:?}");
        assert_eq!(b.pixel(0, 0), [0, 0, 0, 0]);
        assert_eq!(b.pixel(63, 0), [0, 0, 0, 0]);
    }

    #[test]
    fn the_ripple_draws_a_ring_round_the_tip() {
        let ring = RippleFrame {
            radius: 20.0,
            alpha: 0.5,
            stroke: 2.0,
        };
        let with = render_cursor(1.0, 1.0, Some(ring));
        let without = render_cursor(1.0, 1.0, None);
        // Above the tip, away from the arrow and its shadow.
        assert!(with.pixel(32, 32 - 20)[3] > 100);
        assert_eq!(without.pixel(32, 32 - 20)[3], 0);
    }

    #[test]
    fn the_cursor_window_grows_with_the_display_scale() {
        assert_eq!(cursor_window_size(1.0), 64);
        assert_eq!(cursor_window_size(1.5), 96);
        assert_eq!(cursor_window_size(1.25) % 2, 0);
        let b = render_cursor(2.0, 1.0, None);
        assert_eq!(b.width, 128);
        assert!(b.pixel(64 + 4, 64 + 16)[3] == 255);
    }

    #[test]
    fn the_frame_is_an_edge_stroke_with_a_clear_middle() {
        let b = render_frame(300, 200, 1.0);
        assert!(premultiplied_ok(&b));
        assert!(b.pixel(150, 1)[3] > 100, "the stroke is on the edge");
        assert!(b.pixel(150, 6)[3] > 0, "the glow reaches inward");
        assert_eq!(b.pixel(150, 100), [0, 0, 0, 0]);
        assert_eq!(b.pixel(0, 0)[3], 0, "the corner is rounded off");
    }

    #[test]
    fn a_window_smaller_than_the_frame_does_not_panic() {
        for (w, h) in [(1, 1), (3, 40), (10, 10)] {
            let b = render_frame(w, h, 2.0);
            assert_eq!(b.bgra.len(), (w * h * 4) as usize);
        }
    }

    #[test]
    fn constant_alpha_is_clamped() {
        assert_eq!(constant_alpha(-1.0), 0);
        assert_eq!(constant_alpha(2.0), 255);
        assert_eq!(constant_alpha(0.5), 128);
    }
}
