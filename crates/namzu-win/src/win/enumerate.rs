//! Windows and displays: plain Win32 calls, no accessibility call at all.
//!
//! The windows listed are the ones a person sees as windows: visible, not
//! cloaked (another virtual desktop, a suspended app), not a tool window,
//! and without an owner unless asked for. Rectangles are the visible frame
//! (the one the shadow does not count) in virtual-desktop physical pixels.

use namzu_win_core::dpi;
use namzu_win_core::protocol::{Display, Rect, Window};
use namzu_win_core::window_id;
use std::ffi::c_void;
use windows::Win32::Foundation::{CloseHandle, FILETIME, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{
    DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute,
};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
};
use windows::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    QueryFullProcessImageNameW,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GA_PARENT, GA_ROOT, GW_OWNER, GWL_EXSTYLE, GetAncestor,
    GetClassNameW, GetDesktopWindow, GetForegroundWindow, GetWindow, GetWindowLongW,
    GetWindowPlacement, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindow, IsWindowVisible, WINDOWPLACEMENT, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};
use windows::core::{BOOL, PWSTR};

/// A window handle as the protocol carries it: the 32 bits Windows uses.
pub fn hwnd_value(h: HWND) -> u64 {
    h.0 as usize as u64 & 0xFFFF_FFFF
}

pub fn hwnd_from(value: u64) -> HWND {
    HWND(value as usize as *mut c_void)
}

pub fn is_window(h: HWND) -> bool {
    unsafe { IsWindow(Some(h)).as_bool() }
}

pub fn pid_of(h: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
    pid
}

pub fn class_of(h: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn title_of(h: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { GetWindowTextW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

/// True for a window of a browser-engine program, or one that holds one.
pub fn has_chromium(h: HWND) -> bool {
    if window_id::is_chromium_class(&class_of(h)) {
        return true;
    }
    struct Scan {
        seen: u32,
        found: bool,
    }
    unsafe extern "system" fn each(child: HWND, lparam: LPARAM) -> BOOL {
        let scan = unsafe { &mut *(lparam.0 as *mut Scan) };
        scan.seen += 1;
        if window_id::is_chromium_class(&class_of(child)) {
            scan.found = true;
            return false.into();
        }
        (scan.seen < 2000).into()
    }
    let mut scan = Scan {
        seen: 0,
        found: false,
    };
    unsafe {
        let _ = EnumChildWindows(Some(h), Some(each), LPARAM(&mut scan as *mut Scan as isize));
    }
    scan.found
}

pub fn process_name(pid: u32) -> String {
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(process);
        if !ok {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit('\\').next().unwrap_or("").to_owned()
    }
}

/// When the process started, in ms since 1601 (a FILETIME / 10 000); 0 if it cannot be read.
pub fn process_start(pid: u32) -> u64 {
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return 0;
        };
        let (mut created, mut exited, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        let ok =
            GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user).is_ok();
        let _ = CloseHandle(process);
        if !ok {
            return 0;
        }
        let ticks = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
        ticks / 10_000
    }
}

fn cloaked(h: HWND) -> bool {
    let mut value = 0u32;
    unsafe {
        DwmGetWindowAttribute(
            h,
            DWMWA_CLOAKED,
            &mut value as *mut u32 as *mut c_void,
            std::mem::size_of::<u32>() as u32,
        )
        .is_ok()
            && value != 0
    }
}

/// Visible, un-cloaked, not a tool window; without an owner unless `include_owned`.
pub fn listable(h: HWND, include_owned: bool) -> bool {
    unsafe {
        if !IsWindowVisible(h).as_bool() {
            return false;
        }
        let ex = GetWindowLongW(h, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 != 0 && ex & WS_EX_APPWINDOW.0 == 0 {
            return false;
        }
        if !include_owned && GetWindow(h, GW_OWNER).is_ok_and(|owner| !owner.0.is_null()) {
            return false;
        }
        !cloaked(h)
    }
}

pub fn frame_rect(h: HWND, iconic: bool) -> Rect {
    unsafe {
        let mut r = RECT::default();
        if iconic {
            let mut placement = WINDOWPLACEMENT {
                length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                ..Default::default()
            };
            if GetWindowPlacement(h, &mut placement).is_ok() {
                r = placement.rcNormalPosition;
                return rect_of(r);
            }
        }
        let framed = DwmGetWindowAttribute(
            h,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut c_void,
            std::mem::size_of::<RECT>() as u32,
        )
        .is_ok();
        if !framed {
            let _ = GetWindowRect(h, &mut r);
        }
        rect_of(r)
    }
}

pub fn rect_of(r: RECT) -> Rect {
    Rect {
        x: r.left,
        y: r.top,
        width: r.right - r.left,
        height: r.bottom - r.top,
    }
}

fn root_of(h: HWND) -> HWND {
    let root = unsafe { GetAncestor(h, GA_ROOT) };
    if root.0.is_null() { h } else { root }
}

/// The top-level windows, front to back.
pub fn windows(include_owned: bool) -> Vec<Window> {
    unsafe extern "system" fn each(h: HWND, lparam: LPARAM) -> BOOL {
        let found = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
        found.push(h);
        true.into()
    }
    let mut all: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut all as *mut Vec<HWND> as isize));
    }
    let foreground = unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() {
            None
        } else {
            Some(root_of(fg))
        }
    };
    all.into_iter()
        .filter(|h| listable(*h, include_owned))
        .enumerate()
        .map(|(z, h)| {
            let pid = pid_of(h);
            let minimized = unsafe { IsIconic(h).as_bool() };
            Window {
                window_id: window_id::format(hwnd_value(h), pid),
                process_id: pid,
                process_name: process_name(pid),
                title: title_of(h),
                bounds: frame_rect(h, minimized),
                minimized,
                focused: foreground == Some(h),
                z: z as u32,
            }
        })
        .collect()
}

/// True when the window is a top-level one the listing would show (owned ones too).
pub fn is_listed(h: HWND) -> bool {
    is_window(h) && listable(h, true)
}

/// The monitors with their handles, in the order the system lists them.
pub fn monitors() -> Vec<(HMONITOR, Display)> {
    unsafe extern "system" fn each(
        mon: HMONITOR,
        _dc: HDC,
        _rc: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let found = unsafe { &mut *(lparam.0 as *mut Vec<(HMONITOR, Display)>) };
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        let ok =
            unsafe { GetMonitorInfoW(mon, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO) };
        if !ok.as_bool() {
            return true.into();
        }
        let (mut dx, mut dy) = (96u32, 96u32);
        let _ = unsafe { GetDpiForMonitor(mon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) };
        let name_len = info
            .szDevice
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(info.szDevice.len());
        found.push((
            mon,
            Display {
                id: String::from_utf16_lossy(&info.szDevice[..name_len]),
                bounds: rect_of(info.monitorInfo.rcMonitor),
                work_area: rect_of(info.monitorInfo.rcWork),
                scale: dpi::scale_from_dpi(if dx == 0 { 96 } else { dx }),
                primary: info.monitorInfo.dwFlags & 1 != 0,
            },
        ));
        true.into()
    }
    let mut found: Vec<(HMONITOR, Display)> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(each),
            LPARAM(&mut found as *mut Vec<(HMONITOR, Display)> as isize),
        );
    }
    found
}

/// The monitors, in the order the system lists them.
pub fn displays() -> Vec<Display> {
    monitors().into_iter().map(|(_, d)| d).collect()
}

/// The top-level window of `h`, or `h` when it has none (it is gone).
pub fn root(h: HWND) -> (HWND, bool) {
    let root = unsafe { GetAncestor(h, GA_ROOT) };
    if root.0.is_null() {
        (h, true)
    } else {
        (root, false)
    }
}

/// True when `h` is a top-level window (its parent is the desktop).
pub fn is_top_level(h: HWND) -> bool {
    unsafe { GetAncestor(h, GA_PARENT) == GetDesktopWindow() }
}
