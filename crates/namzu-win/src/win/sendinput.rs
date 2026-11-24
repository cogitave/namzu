//! Carrying out an input plan with `SendInput`.
//!
//! `namzu_win_core::input` decides what to send (the points, the path of a
//! drag, the key events of a text); this file turns each step into one
//! `INPUT` record and hands them to the system in batches, pausing where the
//! plan says to. The system's answer is checked: when it takes fewer records
//! than were sent, something else holds the input desktop (a secure prompt, a
//! program with more rights) and the caller is told, not left to guess.

use namzu_win_core::input::{Step, release_after};
use namzu_win_core::keys::is_extended;
use namzu_win_core::protocol::{ErrorCode, MouseButton, WireError};
use std::time::Duration;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, MOUSE_EVENT_FLAGS,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MapVirtualKeyW,
    SendInput, VIRTUAL_KEY, VkKeyScanW,
};

/// Records handed to the system at once.
const BATCH: usize = 256;

const VK_LSHIFT: u16 = 0xA0;
const VK_LCONTROL: u16 = 0xA2;
const VK_LMENU: u16 = 0xA4;

fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn keyboard(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn key(vk: u16, up: bool) -> INPUT {
    // SAFETY: a plain lookup.
    let scan = unsafe { MapVirtualKeyW(u32::from(vk), MAPVK_VK_TO_VSC) } as u16;
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    if is_extended(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    keyboard(vk, scan, flags)
}

fn unit(unit: u16, up: bool) -> INPUT {
    let mut flags = KEYEVENTF_UNICODE;
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    keyboard(0, unit, flags)
}

fn button_flag(button: MouseButton, down: bool) -> MOUSE_EVENT_FLAGS {
    match (button, down) {
        (MouseButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
        (MouseButton::Left, false) => MOUSEEVENTF_LEFTUP,
        (MouseButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
        (MouseButton::Right, false) => MOUSEEVENTF_RIGHTUP,
        (MouseButton::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
        (MouseButton::Middle, false) => MOUSEEVENTF_MIDDLEUP,
    }
}

/// The modifier keys a `VkKeyScanW` answer needs held.
fn modifiers_of(scan: i16) -> Vec<u16> {
    let state = ((scan >> 8) & 0xFF) as u8;
    let mut held: Vec<u16> = Vec::new();
    if state & 1 != 0 {
        held.push(VK_LSHIFT);
    }
    if state & 2 != 0 {
        held.push(VK_LCONTROL);
    }
    if state & 4 != 0 {
        held.push(VK_LMENU);
    }
    held
}

/// The modifiers `press` holds for a character, none when it goes as Unicode.
fn press_modifiers(ch: char) -> Vec<u16> {
    let mut units = [0u16; 2];
    let encoded = ch.encode_utf16(&mut units);
    if encoded.len() != 1 {
        return Vec::new();
    }
    // SAFETY: a plain lookup.
    let scan = unsafe { VkKeyScanW(encoded[0]) };
    if scan == -1 {
        Vec::new()
    } else {
        modifiers_of(scan)
    }
}

/// A character that is no key of its own in a combination: its key and
/// modifiers in the current layout, or its Unicode units when the layout has
/// none for it.
fn press(ch: char) -> Vec<INPUT> {
    let mut units = [0u16; 2];
    let encoded = ch.encode_utf16(&mut units);
    // SAFETY: a plain lookup.
    let scan = if encoded.len() == 1 {
        unsafe { VkKeyScanW(encoded[0]) }
    } else {
        -1
    };
    if scan == -1 {
        return encoded
            .iter()
            .flat_map(|u| [unit(*u, false), unit(*u, true)])
            .collect();
    }
    let vk = (scan & 0xFF) as u16;
    let held = modifiers_of(scan);
    let mut out: Vec<INPUT> = held.iter().map(|m| key(*m, false)).collect();
    out.push(key(vk, false));
    out.push(key(vk, true));
    out.extend(held.iter().rev().map(|m| key(*m, true)));
    out
}

fn records(step: &Step) -> Vec<INPUT> {
    match *step {
        Step::MoveTo { x, y } => vec![mouse(
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
            x,
            y,
            0,
        )],
        Step::Button { button, down } => vec![mouse(button_flag(button, down), 0, 0, 0)],
        Step::Wheel { horizontal, delta } => vec![mouse(
            if horizontal {
                MOUSEEVENTF_HWHEEL
            } else {
                MOUSEEVENTF_WHEEL
            },
            0,
            0,
            // The wheel's amount is a signed value carried in an unsigned field.
            delta as u32,
        )],
        Step::Key { vk, up } => vec![key(vk, up)],
        Step::Press { ch } => press(ch),
        Step::Unit { unit: u, up } => vec![unit(u, up)],
        Step::Pause { .. } => Vec::new(),
    }
}

fn flush(batch: &mut Vec<INPUT>, delivered: &mut u32) -> Result<(), WireError> {
    if batch.is_empty() {
        return Ok(());
    }
    // SAFETY: `batch` holds fully built records and the size is theirs.
    let sent = unsafe { SendInput(batch, std::mem::size_of::<INPUT>() as i32) } as usize;
    *delivered += sent as u32;
    let wanted = batch.len();
    batch.clear();
    if sent == wanted {
        Ok(())
    } else {
        Err(WireError::new(
            ErrorCode::InputBlocked,
            format!(
                "the system took {sent} of {wanted} input events: another program holds the input (a secure prompt, or a program with more rights)"
            ),
        ))
    }
}

/// Sends the plan. Returns how many input events the system took. When it
/// takes only part, every button and key the steps so far left down is put
/// back up (best effort) before the error is returned.
pub fn send(steps: &[Step]) -> Result<u32, WireError> {
    let mut delivered = 0u32;
    match run(steps, &mut delivered) {
        Ok(()) => Ok(delivered),
        Err((consumed, error)) => {
            release(&steps[..consumed]);
            Err(error)
        }
    }
}

/// Errs with how many steps had been taken into a batch when the system refused.
fn run(steps: &[Step], delivered: &mut u32) -> Result<(), (usize, WireError)> {
    let mut batch: Vec<INPUT> = Vec::new();
    for (i, step) in steps.iter().enumerate() {
        if let Step::Pause { ms } = step {
            flush(&mut batch, delivered).map_err(|e| (i, e))?;
            std::thread::sleep(Duration::from_millis(u64::from(*ms)));
            continue;
        }
        batch.extend(records(step));
        if batch.len() >= BATCH {
            flush(&mut batch, delivered).map_err(|e| (i + 1, e))?;
        }
    }
    flush(&mut batch, delivered).map_err(|e| (steps.len(), e))
}

/// Puts back up what a cut-short plan left down. A character typed through a
/// layout that was the last step may have its modifiers down too.
fn release(consumed: &[Step]) {
    let mut ups: Vec<INPUT> = Vec::new();
    if let Some(Step::Press { ch }) = consumed.last() {
        ups.extend(press_modifiers(*ch).iter().rev().map(|m| key(*m, true)));
    }
    ups.extend(release_after(consumed).iter().flat_map(records));
    let mut delivered = 0;
    let _ = flush(&mut ups, &mut delivered);
}

/// Taps one virtual key. A failure is ignored: the tap only gives this
/// program the right to take the front, and the raise says if it did not.
pub fn tap_key(vk: u16) {
    let mut batch = vec![key(vk, false), key(vk, true)];
    let mut delivered = 0;
    let _ = flush(&mut batch, &mut delivered);
}
