//! `input`: pointer and keyboard input at the screen, as a plan the platform
//! layer only has to carry out.
//!
//! The wire shapes are here, and so is every decision that is not a Windows
//! call: where a physical-pixel point lands in the 0..=65535 space `SendInput`
//! takes, the path of a drag, how many wheel notches a scroll is, how a text
//! becomes key events, which keys of a combination go down first. The result
//! is a list of [`Step`]s. The Windows side turns each step into one input
//! event or one short pause and sends them, so the same text, the same drag
//! and the same combination are checked by tests that run anywhere.

use crate::dpi::{self, Point};
use crate::keys::{Combo, Key};
use crate::protocol::{MouseButton, Rect};
use serde::{Deserialize, Serialize};

/// The most characters one `type` may carry.
pub const MAX_TYPE_CHARS: usize = 100_000;
pub const MAX_SCROLL_NOTCHES: u32 = 100;
/// One notch of a mouse wheel, as `SendInput` counts it.
pub const WHEEL_DELTA: i32 = 120;
/// Intermediate points of a drag, and the pause after each (ms).
pub const DRAG_STEPS: u32 = 12;
pub const DRAG_PAUSE_MS: u32 = 15;
/// Lets the pointer land before the button goes down (ms).
pub const SETTLE_MS: u32 = 15;
/// Between the clicks of a double or triple click (ms); well inside the system's double-click time.
pub const MULTI_CLICK_PAUSE_MS: u32 = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

/// One input the caller asks for. Points are virtual-desktop physical pixels.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InputRequest {
    Click {
        x: i32,
        y: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        button: Option<MouseButton>,
        /// Clicks in a row: 1 (default) to 3.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        count: Option<u8>,
    },
    Move {
        x: i32,
        y: i32,
    },
    Drag {
        x: i32,
        y: i32,
        #[serde(rename = "toX")]
        to_x: i32,
        #[serde(rename = "toY")]
        to_y: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        button: Option<MouseButton>,
    },
    Scroll {
        x: i32,
        y: i32,
        direction: ScrollDirection,
        /// Wheel notches, 1 (default) to 100.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        amount: Option<u32>,
    },
    /// Types `text` as Unicode key events, whatever the keyboard layout.
    Type {
        text: String,
    },
    /// Presses a combination such as `ctrl+shift+t`.
    Key {
        keys: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputVia {
    SendInput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputReply {
    /// Input events the system took.
    pub delivered: u32,
    pub via: InputVia,
    /// Where the pointer is afterwards, for an input that moves it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<Point>,
}

/// One thing the platform layer does, in order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// The pointer to a point of the 0..=65535 space over the virtual desktop.
    MoveTo {
        x: i32,
        y: i32,
    },
    Button {
        button: MouseButton,
        down: bool,
    },
    Wheel {
        horizontal: bool,
        delta: i32,
    },
    /// A virtual key.
    Key {
        vk: u16,
        up: bool,
    },
    /// A character that has no virtual key of its own in a combination: the
    /// platform layer looks it up in the current layout, else sends it as Unicode.
    Press {
        ch: char,
    },
    /// One UTF-16 unit as a Unicode key event.
    Unit {
        unit: u16,
        up: bool,
    },
    Pause {
        ms: u32,
    },
}

impl Step {
    /// True for a step that is one input event (everything but a pause).
    pub fn is_event(&self) -> bool {
        !matches!(self, Step::Pause { .. })
    }
}

/// How many input events a plan holds.
pub fn event_count(steps: &[Step]) -> u32 {
    steps.iter().filter(|s| s.is_event()).count() as u32
}

/// The virtual desktop, for turning a point into `SendInput`'s space.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Desktop {
    pub bounds: Rect,
}

impl Desktop {
    pub fn of(monitors: &[dpi::Monitor]) -> Option<Desktop> {
        dpi::virtual_bounds(monitors).map(|bounds| Desktop { bounds })
    }

    /// The point in the 0..=65535 space. A point off the desktop is refused:
    /// clamping it would click somewhere the caller did not ask for.
    pub fn absolute(&self, p: Point) -> Result<(i32, i32), String> {
        if !self.bounds.contains(p) {
            return Err(format!(
                "the point ({}, {}) is outside every display",
                p.x, p.y
            ));
        }
        Ok(dpi::to_absolute(p, &self.bounds))
    }

    fn move_to(&self, p: Point) -> Result<Step, String> {
        let (x, y) = self.absolute(p)?;
        Ok(Step::MoveTo { x, y })
    }
}

/// A click of `count` presses at `at`.
pub fn click_steps(
    desktop: &Desktop,
    at: Point,
    button: MouseButton,
    count: u8,
) -> Result<Vec<Step>, String> {
    if !(1..=3).contains(&count) {
        return Err("count is 1, 2 or 3".into());
    }
    let mut steps = vec![desktop.move_to(at)?, Step::Pause { ms: SETTLE_MS }];
    for i in 0..count {
        if i > 0 {
            steps.push(Step::Pause {
                ms: MULTI_CLICK_PAUSE_MS,
            });
        }
        steps.push(Step::Button { button, down: true });
        steps.push(Step::Button {
            button,
            down: false,
        });
    }
    Ok(steps)
}

pub fn move_steps(desktop: &Desktop, to: Point) -> Result<Vec<Step>, String> {
    Ok(vec![desktop.move_to(to)?])
}

/// The points a drag passes: `steps` of them, the last one the end. Many
/// targets ignore a drag that jumps.
pub fn drag_path(from: Point, to: Point, steps: u32) -> Vec<Point> {
    (1..=steps)
        .map(|i| {
            let t = f64::from(i) / f64::from(steps);
            let lerp = |a: i32, b: i32| (f64::from(a) + f64::from(b - a) * t).round() as i32;
            Point {
                x: lerp(from.x, to.x),
                y: lerp(from.y, to.y),
            }
        })
        .collect()
}

/// Press at `from`, move through the path to `to`, release.
pub fn drag_steps(
    desktop: &Desktop,
    from: Point,
    to: Point,
    button: MouseButton,
) -> Result<Vec<Step>, String> {
    let mut steps = vec![
        desktop.move_to(from)?,
        Step::Pause { ms: SETTLE_MS },
        Step::Button { button, down: true },
    ];
    for p in drag_path(from, to, DRAG_STEPS) {
        steps.push(desktop.move_to(p)?);
        steps.push(Step::Pause { ms: DRAG_PAUSE_MS });
    }
    steps.push(Step::Button {
        button,
        down: false,
    });
    Ok(steps)
}

/// The wheel at `at`: up and right are positive.
pub fn scroll_steps(
    desktop: &Desktop,
    at: Point,
    direction: ScrollDirection,
    amount: u32,
) -> Result<Vec<Step>, String> {
    if !(1..=MAX_SCROLL_NOTCHES).contains(&amount) {
        return Err(format!("amount is 1 to {MAX_SCROLL_NOTCHES}"));
    }
    let (horizontal, sign) = match direction {
        ScrollDirection::Up => (false, 1),
        ScrollDirection::Down => (false, -1),
        ScrollDirection::Right => (true, 1),
        ScrollDirection::Left => (true, -1),
    };
    Ok(vec![
        desktop.move_to(at)?,
        Step::Pause { ms: SETTLE_MS },
        Step::Wheel {
            horizontal,
            delta: sign * WHEEL_DELTA * amount as i32,
        },
    ])
}

fn tap(vk: u16) -> [Step; 2] {
    [Step::Key { vk, up: false }, Step::Key { vk, up: true }]
}

/// `text` as key events: a line break is the Enter key (a `\r\n` pair is one),
/// a tab is the Tab key, anything else is its UTF-16 units as Unicode key
/// events, so the keyboard layout cannot change what is typed.
pub fn text_steps(text: &str) -> Result<Vec<Step>, String> {
    if text.chars().count() > MAX_TYPE_CHARS {
        return Err(format!("text is longer than {MAX_TYPE_CHARS} characters"));
    }
    let mut steps = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                steps.extend(tap(0x0D));
            }
            '\n' => steps.extend(tap(0x0D)),
            '\t' => steps.extend(tap(0x09)),
            c => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units).iter().copied() {
                    steps.push(Step::Unit { unit, up: false });
                    steps.push(Step::Unit { unit, up: true });
                }
            }
        }
    }
    Ok(steps)
}

/// A combination: the modifiers down in the order written, the key tapped,
/// the modifiers up in the reverse order.
pub fn key_steps(combo: &Combo) -> Vec<Step> {
    let mut steps = Vec::new();
    for m in &combo.modifiers {
        steps.push(Step::Key {
            vk: m.vk(),
            up: false,
        });
    }
    match combo.key {
        Key::Vk(vk) => steps.extend(tap(vk)),
        Key::Char(ch) => steps.push(Step::Press { ch }),
    }
    for m in combo.modifiers.iter().rev() {
        steps.push(Step::Key {
            vk: m.vk(),
            up: true,
        });
    }
    steps
}

/// A request turned into the steps that carry it out.
pub fn plan(request: &InputRequest, desktop: &Desktop) -> Result<Vec<Step>, String> {
    match request {
        InputRequest::Click {
            x,
            y,
            button,
            count,
        } => click_steps(
            desktop,
            Point { x: *x, y: *y },
            button.unwrap_or(MouseButton::Left),
            count.unwrap_or(1),
        ),
        InputRequest::Move { x, y } => move_steps(desktop, Point { x: *x, y: *y }),
        InputRequest::Drag {
            x,
            y,
            to_x,
            to_y,
            button,
        } => drag_steps(
            desktop,
            Point { x: *x, y: *y },
            Point { x: *to_x, y: *to_y },
            button.unwrap_or(MouseButton::Left),
        ),
        InputRequest::Scroll {
            x,
            y,
            direction,
            amount,
        } => scroll_steps(
            desktop,
            Point { x: *x, y: *y },
            *direction,
            amount.unwrap_or(1),
        ),
        InputRequest::Type { text } => text_steps(text),
        InputRequest::Key { keys } => crate::keys::parse_combo(keys)
            .map(|c| key_steps(&c))
            .map_err(|e| e.to_string()),
    }
}

/// Where the pointer ends up after `request`, when it moves it.
pub fn cursor_after(request: &InputRequest) -> Option<Point> {
    match request {
        InputRequest::Click { x, y, .. }
        | InputRequest::Move { x, y }
        | InputRequest::Scroll { x, y, .. } => Some(Point { x: *x, y: *y }),
        InputRequest::Drag { to_x, to_y, .. } => Some(Point { x: *to_x, y: *to_y }),
        InputRequest::Type { .. } | InputRequest::Key { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dpi::Monitor;
    use crate::keys::parse_combo;

    fn desktop() -> Desktop {
        Desktop::of(&[
            Monitor {
                id: "left".into(),
                bounds: Rect {
                    x: -1920,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
                dpi: 96,
            },
            Monitor {
                id: "main".into(),
                bounds: Rect {
                    x: 0,
                    y: 0,
                    width: 3840,
                    height: 2160,
                },
                dpi: 192,
            },
        ])
        .unwrap()
    }

    #[test]
    fn a_point_off_every_display_is_refused() {
        let d = desktop();
        assert!(d.absolute(Point { x: 5000, y: 10 }).is_err());
        assert!(d.absolute(Point { x: -1921, y: 10 }).is_err());
        assert_eq!(d.absolute(Point { x: -1920, y: 0 }).unwrap(), (0, 0));
    }

    #[test]
    fn a_click_moves_settles_then_presses() {
        let d = desktop();
        let s = click_steps(&d, Point { x: 0, y: 0 }, MouseButton::Right, 2).unwrap();
        assert_eq!(
            s,
            vec![
                Step::MoveTo { x: 21849, y: 0 },
                Step::Pause { ms: SETTLE_MS },
                Step::Button {
                    button: MouseButton::Right,
                    down: true
                },
                Step::Button {
                    button: MouseButton::Right,
                    down: false
                },
                Step::Pause {
                    ms: MULTI_CLICK_PAUSE_MS
                },
                Step::Button {
                    button: MouseButton::Right,
                    down: true
                },
                Step::Button {
                    button: MouseButton::Right,
                    down: false
                },
            ]
        );
        assert_eq!(event_count(&s), 5);
        assert!(click_steps(&d, Point { x: 0, y: 0 }, MouseButton::Left, 4).is_err());
    }

    #[test]
    fn a_drag_passes_through_points_and_ends_on_the_target() {
        let path = drag_path(Point { x: 0, y: 0 }, Point { x: 120, y: 60 }, 12);
        assert_eq!(path.len(), 12);
        assert_eq!(path[0], Point { x: 10, y: 5 });
        assert_eq!(path[11], Point { x: 120, y: 60 });
        let d = desktop();
        let s = drag_steps(
            &d,
            Point { x: 10, y: 10 },
            Point { x: 100, y: 10 },
            MouseButton::Left,
        )
        .unwrap();
        assert!(matches!(s[2], Step::Button { down: true, .. }));
        assert!(matches!(s.last(), Some(Step::Button { down: false, .. })));
        assert_eq!(event_count(&s), 1 + 1 + 12 + 1);
    }

    #[test]
    fn a_scroll_is_whole_notches_with_a_sign() {
        let d = desktop();
        let at = Point { x: 10, y: 10 };
        let down = scroll_steps(&d, at, ScrollDirection::Down, 3).unwrap();
        assert_eq!(
            down[2],
            Step::Wheel {
                horizontal: false,
                delta: -360
            }
        );
        let right = scroll_steps(&d, at, ScrollDirection::Right, 1).unwrap();
        assert_eq!(
            right[2],
            Step::Wheel {
                horizontal: true,
                delta: 120
            }
        );
        assert!(scroll_steps(&d, at, ScrollDirection::Up, 0).is_err());
        assert!(scroll_steps(&d, at, ScrollDirection::Up, 101).is_err());
    }

    #[test]
    fn text_becomes_unicode_units_with_line_breaks_as_enter() {
        let s = text_steps("a\r\nb\tc").unwrap();
        let want = [
            Step::Unit {
                unit: 'a' as u16,
                up: false,
            },
            Step::Unit {
                unit: 'a' as u16,
                up: true,
            },
            Step::Key {
                vk: 0x0D,
                up: false,
            },
            Step::Key { vk: 0x0D, up: true },
            Step::Unit {
                unit: 'b' as u16,
                up: false,
            },
            Step::Unit {
                unit: 'b' as u16,
                up: true,
            },
            Step::Key {
                vk: 0x09,
                up: false,
            },
            Step::Key { vk: 0x09, up: true },
            Step::Unit {
                unit: 'c' as u16,
                up: false,
            },
            Step::Unit {
                unit: 'c' as u16,
                up: true,
            },
        ];
        assert_eq!(s, want);
        // A lone \r and a lone \n are one Enter each.
        assert_eq!(text_steps("\r\r\n\n").unwrap().len(), 6);
    }

    #[test]
    fn a_character_outside_the_basic_plane_is_two_units() {
        let s = text_steps("\u{1F600}").unwrap();
        assert_eq!(s.len(), 4);
        assert_eq!(
            s[0],
            Step::Unit {
                unit: 0xD83D,
                up: false
            }
        );
        assert_eq!(
            s[2],
            Step::Unit {
                unit: 0xDE00,
                up: false
            }
        );
        assert!(text_steps(&"a".repeat(MAX_TYPE_CHARS + 1)).is_err());
    }

    #[test]
    fn a_combination_holds_modifiers_around_the_key() {
        let s = key_steps(&parse_combo("ctrl+shift+t").unwrap());
        assert_eq!(
            s,
            vec![
                Step::Key {
                    vk: 0xA2,
                    up: false
                },
                Step::Key {
                    vk: 0xA0,
                    up: false
                },
                Step::Key {
                    vk: 0x54,
                    up: false
                },
                Step::Key { vk: 0x54, up: true },
                Step::Key { vk: 0xA0, up: true },
                Step::Key { vk: 0xA2, up: true },
            ]
        );
        let c = key_steps(&parse_combo("ctrl++").unwrap());
        assert!(c.contains(&Step::Press { ch: '+' }));
    }

    #[test]
    fn plan_reaches_every_request_and_names_where_the_pointer_ends() {
        let d = desktop();
        let r = InputRequest::Click {
            x: 5,
            y: 6,
            button: None,
            count: None,
        };
        assert_eq!(plan(&r, &d).unwrap().len(), 4);
        assert_eq!(cursor_after(&r), Some(Point { x: 5, y: 6 }));
        let k = InputRequest::Key {
            keys: "hyper+x".into(),
        };
        assert!(plan(&k, &d).is_err());
        assert_eq!(cursor_after(&k), None);
    }
}
