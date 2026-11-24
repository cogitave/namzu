//! The window in front, bringing one forward, and the facts about the desktop
//! a burst of input needs: where the pointer is, which desktop takes input,
//! how long a person has been still.
//!
//! The raise is the one the PowerShell foreground helper made, in the same
//! order: ask plainly; tap an unassigned key (which gives this program the
//! right to take the front); borrow the front window's input queue; and last
//! the shell's switch call. It reports how far it had to go, or that Windows
//! would not give the front, and never loops.

use super::enumerate::{hwnd_value, is_window, pid_of, process_name, root};
use super::proc;
use namzu_win_core::dpi::Point;
use namzu_win_core::foreground::{
    ForegroundState, ForegroundTarget, ForegroundWindow, OwnInput, RaiseHow, Win, user_idle_ms,
};
use namzu_win_core::window_id;
use std::time::Duration;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, GetUserObjectInformationW,
    OpenInputDesktop, UOI_NAME,
};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetForegroundWindow, GetWindowThreadProcessId, IsIconic, SW_RESTORE,
    SetCursorPos, SetForegroundWindow, ShowWindow, SwitchToThisWindow,
};

/// The unassigned virtual key whose tap gives this program the right to take the front.
const UNLOCK_KEY: u16 = 0xE8;

/// The top-level window in front, if any.
pub fn front() -> Option<HWND> {
    let fg = unsafe { GetForegroundWindow() };
    if fg.0.is_null() {
        None
    } else {
        Some(root(fg).0)
    }
}

pub fn win_of(h: HWND) -> Win {
    Win {
        hwnd: hwnd_value(h),
        pid: pid_of(h),
    }
}

pub fn front_win() -> Option<Win> {
    front().map(win_of)
}

pub fn cursor() -> Point {
    let mut p = POINT::default();
    // SAFETY: a plain call into a local.
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    Point { x: p.x, y: p.y }
}

pub fn set_cursor(p: Point) -> bool {
    unsafe { SetCursorPos(p.x, p.y).is_ok() }
}

/// The input desktop's name, or `(unreadable)`.
pub fn desktop_name() -> String {
    const UNREADABLE: &str = "(unreadable)";
    unsafe {
        let Ok(desktop) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
        else {
            return UNREADABLE.to_owned();
        };
        let mut buffer = [0u16; 256];
        let mut needed = 0u32;
        let ok = GetUserObjectInformationW(
            windows::Win32::Foundation::HANDLE(desktop.0),
            UOI_NAME,
            Some(buffer.as_mut_ptr().cast()),
            (buffer.len() * 2) as u32,
            Some(&mut needed),
        )
        .is_ok();
        let _ = CloseDesktop(desktop);
        if !ok {
            return UNREADABLE.to_owned();
        }
        let len = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..len])
    }
}

/// The system tick (ms, wrapping) now.
pub fn tick() -> u32 {
    unsafe { GetTickCount() }
}

/// The tick of the system's last input of any kind.
pub fn last_input_tick() -> u32 {
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` is sized as the call requires.
    unsafe {
        let _ = GetLastInputInfo(&mut info);
    }
    info.dwTime
}

/// A key or mouse button is physically down right now.
fn any_held() -> bool {
    // Mouse buttons 1-6, then the keys; 3 (cancel), 7 and 0xE7 are not keys a person holds.
    (1..255u16).any(|vk| {
        if matches!(vk, 3 | 7 | 0xE7) {
            return false;
        }
        (unsafe { GetAsyncKeyState(i32::from(vk)) } as u16) & 0x8000 != 0
    })
}

/// The helper's own sending, in system ticks.
#[derive(Debug, Clone, Copy)]
pub struct OwnTicks {
    pub start: u32,
    /// `None` while a lease is held.
    pub end: Option<u32>,
}

fn window_info(h: HWND, own_level: i32) -> ForegroundWindow {
    let pid = pid_of(h);
    ForegroundWindow {
        window_id: window_id::format(hwnd_value(h), pid),
        process_id: pid,
        exe: process_name(pid),
        elevated: proc::elevated(pid, own_level),
        integrity: proc::integrity(pid),
    }
}

/// What the desktop looks like now. `target` also describes that program.
pub fn state(own: Option<OwnTicks>, target_pid: Option<u32>) -> ForegroundState {
    let own_level = proc::self_integrity();
    let now = tick();
    let since = |t: u32| u64::from(now.wrapping_sub(t));
    let last = last_input_tick();
    let own = own.map(|o| OwnInput {
        since_start: since(o.start),
        since_end: o.end.map(since),
    });
    ForegroundState {
        foreground: front().map(|h| window_info(h, own_level)),
        cursor: cursor(),
        desktop: desktop_name(),
        self_elevated: own_level >= 0x3000,
        self_integrity: own_level,
        input_tick: u64::from(last),
        user_idle_ms: user_idle_ms(since(last), own, any_held()),
        target: target_pid.map(|pid| ForegroundTarget {
            exe: process_name(pid),
            elevated: proc::elevated(pid, own_level),
            integrity: proc::integrity(pid),
        }),
    }
}

fn is_front(h: HWND) -> bool {
    unsafe { GetForegroundWindow() == h }
}

/// Brings `h` to the front, restoring it when minimized. The caller has
/// checked that it is a window.
pub fn raise(h: HWND) -> RaiseHow {
    unsafe {
        let current = GetForegroundWindow();
        if current == h {
            return RaiseHow::Already;
        }
        if IsIconic(h).as_bool() {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        let _ = SetForegroundWindow(h);
        if is_front(h) {
            return RaiseHow::Plain;
        }
        // Windows lets a program take the front only if it has just been given
        // input. An unassigned key tapped by this program does that and does
        // nothing in any window.
        super::sendinput::tap_key(UNLOCK_KEY);
        let _ = SetForegroundWindow(h);
        if is_front(h) {
            return RaiseHow::Unlock;
        }
        let current_thread = GetWindowThreadProcessId(current, None);
        let own_thread = GetCurrentThreadId();
        let attached = current_thread != 0
            && current_thread != own_thread
            && AttachThreadInput(own_thread, current_thread, true).as_bool();
        let _ = SetForegroundWindow(h);
        if attached {
            let _ = AttachThreadInput(own_thread, current_thread, false);
        }
        if is_front(h) {
            return RaiseHow::Attach;
        }
        SwitchToThisWindow(h, true);
        std::thread::sleep(Duration::from_millis(30));
        if is_front(h) {
            return RaiseHow::Switch;
        }
        RaiseHow::Refused
    }
}

/// True when `h` is a window that exists.
pub fn exists(h: HWND) -> bool {
    is_window(h)
}
