//! Watching the desk without a global hook: that a person used the keyboard or
//! the mouse, and which window came to the front.
//!
//! Input is learned through Raw Input registered with `RIDEV_INPUTSINK` on a
//! message-only window. A `WM_INPUT` message is read through its header only
//! (`RID_HEADER`): the header says which class of device sent it and whether
//! the system synthesised it (`hDevice` is null for `SendInput`). The body of
//! the message, where a key or a button would be, is never requested, so
//! nothing here can know what a person typed. There is no `SetWindowsHookEx`,
//! and no code of this helper runs inside another program.
//!
//! The foreground is followed with `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`,
//! delivered to this thread's message loop.
//!
//! One thread does all of it and nothing else. Events go into a
//! [`MonitorLog`], which the `monitor.poll` op and the lease read.

use namzu_win_core::monitor::{Device, Hook, MonitorLog, MonitorPollReply, MonitorStartRequest};
use namzu_win_core::window_id;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::channel;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::thread::JoinHandle;
use std::time::Instant;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::Input::{
    GetRawInputData, HRAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER, RID_HEADER, RIDEV_INPUTSINK,
    RIDEV_REMOVE, RIM_TYPEKEYBOARD, RIM_TYPEMOUSE, RegisterRawInputDevices,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetForegroundWindow,
    GetMessageW, HWND_MESSAGE, MSG, PM_NOREMOVE, PeekMessageW, PostThreadMessageW,
    RegisterClassExW, TranslateMessage, UnregisterClassW, WINDOW_EX_STYLE, WINDOW_STYLE, WM_INPUT,
    WM_QUIT, WNDCLASSEXW,
};
use windows::core::w;

use super::enumerate;

const EVENT_SYSTEM_FOREGROUND: u32 = 3;
const WINEVENT_OUTOFCONTEXT: u32 = 0;
/// The usage page and usages of the generic desktop keyboard and mouse.
const USAGE_PAGE_GENERIC: u16 = 0x01;
const USAGE_MOUSE: u16 = 0x02;
const USAGE_KEYBOARD: u16 = 0x06;

fn log() -> MutexGuard<'static, MonitorLog> {
    static LOG: OnceLock<Mutex<MonitorLog>> = OnceLock::new();
    match LOG.get_or_init(|| Mutex::new(MonitorLog::new())).lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

fn epoch() -> &'static Instant {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    EPOCH.get_or_init(Instant::now)
}

fn now_ms() -> u64 {
    epoch().elapsed().as_millis() as u64
}

/// The window (as `window_id` counts it) the monitor last recorded as in front,
/// or 0 before there is one.
static LAST_FRONT: AtomicU64 = AtomicU64::new(0);
/// The foreground is being watched, so a poll checks it against what was recorded.
static WATCHING_FOREGROUND: AtomicBool = AtomicBool::new(false);

/// The top-level window in front now, or `None` when there is none.
fn front_root() -> Option<HWND> {
    // SAFETY: a plain query.
    let fg = unsafe { GetForegroundWindow() };
    (!fg.0.is_null()).then(|| enumerate::root(fg).0)
}

/// Records `root` as having come to the front, unless it is the window the
/// monitor already recorded (an event and a poll's own check can both see one change).
fn record_front(root: HWND) {
    let value = enumerate::hwnd_value(root);
    if LAST_FRONT.swap(value, Ordering::SeqCst) == value {
        return;
    }
    let id = window_id::format(value, enumerate::pid_of(root));
    log().record_foreground(now_ms(), id);
}

/// A person's input events counted so far (all of them, from the start of the helper's monitor).
pub fn person_inputs() -> u64 {
    log().inputs()
}

/// The log as `monitor.poll` reports it.
pub fn poll(since: Option<u64>) -> MonitorPollReply {
    // The system is not guaranteed to deliver every foreground event to an
    // out-of-context hook (a change can come with none), so what is in front
    // is also read here, and a change the hook did not report is recorded.
    if WATCHING_FOREGROUND.load(Ordering::SeqCst) {
        if let Some(front) = front_root() {
            record_front(front);
        }
    }
    log().poll(since, now_ms())
}

pub struct Monitor {
    thread_id: u32,
    join: Option<JoinHandle<()>>,
    pub input: bool,
    pub foreground: bool,
}

unsafe extern "system" fn on_foreground(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    if event != EVENT_SYSTEM_FOREGROUND || hwnd.0.is_null() {
        return;
    }
    record_front(enumerate::root(hwnd).0);
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_INPUT {
        // The header alone: which device class, and whether the system made it up.
        let mut header = RAWINPUTHEADER::default();
        let size = std::mem::size_of::<RAWINPUTHEADER>() as u32;
        let mut got = size;
        // SAFETY: `header` is `size` bytes, as the call is told.
        let n = unsafe {
            GetRawInputData(
                HRAWINPUT(lparam.0 as *mut c_void),
                RID_HEADER,
                Some(&mut header as *mut RAWINPUTHEADER as *mut c_void),
                &mut got,
                size,
            )
        };
        if n == size {
            let device = match header.dwType {
                t if t == RIM_TYPEKEYBOARD.0 => Some(Device::Keyboard),
                t if t == RIM_TYPEMOUSE.0 => Some(Device::Mouse),
                _ => None,
            };
            if let Some(device) = device {
                log().record_input(now_ms(), device, header.hDevice.is_invalid());
            }
        }
    }
    // The system cleans up after a message sent to an input sink in here.
    // SAFETY: the arguments are the ones the system gave this procedure.
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

impl Monitor {
    /// Starts the thread. `None` when it did not come up at all; `input` and
    /// `foreground` say which of the two things are being watched.
    pub fn start(request: &MonitorStartRequest) -> Option<Monitor> {
        let want_input = request.wants(Hook::Input);
        let want_foreground = request.wants(Hook::Foreground);
        let _ = epoch();
        let (ready_tx, ready_rx) = channel::<(u32, bool, bool)>();
        let join = std::thread::Builder::new()
            .name("namzu-win-monitor".to_owned())
            .spawn(move || run(want_input, want_foreground, ready_tx))
            .ok()?;
        let (thread_id, input, foreground) = ready_rx.recv().ok()?;
        WATCHING_FOREGROUND.store(foreground, Ordering::SeqCst);
        Some(Monitor {
            thread_id,
            join: Some(join),
            input,
            foreground,
        })
    }

    /// Stops watching and waits for the thread to finish.
    pub fn stop(mut self) {
        WATCHING_FOREGROUND.store(false, Ordering::SeqCst);
        // SAFETY: a plain post to a thread of this process.
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

fn run(want_input: bool, want_foreground: bool, ready: std::sync::mpsc::Sender<(u32, bool, bool)>) {
    // SAFETY: the calls below follow their documented contracts; handles made
    // here are released here before the thread ends.
    unsafe {
        let mut msg = MSG::default();
        // Touching the queue creates it, so a message posted early is kept.
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(wnd_proc),
            lpszClassName: w!("NamzuWinMonitor"),
            ..Default::default()
        };
        let _ = RegisterClassExW(&class);
        let window = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("NamzuWinMonitor"),
            w!(""),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            None,
            None,
        )
        .ok();
        let mut input = false;
        if want_input {
            if let Some(w) = window {
                let list = [USAGE_KEYBOARD, USAGE_MOUSE].map(|usage| RAWINPUTDEVICE {
                    usUsagePage: USAGE_PAGE_GENERIC,
                    usUsage: usage,
                    dwFlags: RIDEV_INPUTSINK,
                    hwndTarget: w,
                });
                input =
                    RegisterRawInputDevices(&list, std::mem::size_of::<RAWINPUTDEVICE>() as u32)
                        .is_ok();
            }
        }
        let mut hook = HWINEVENTHOOK::default();
        if want_foreground {
            // What is in front at the start is not a change, so it is not recorded.
            LAST_FRONT.store(
                front_root().map_or(0, enumerate::hwnd_value),
                Ordering::SeqCst,
            );
            hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                None,
                Some(on_foreground),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
        }
        let _ = ready.send((GetCurrentThreadId(), input, !hook.0.is_null()));
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if input {
            let list = [USAGE_KEYBOARD, USAGE_MOUSE].map(|usage| RAWINPUTDEVICE {
                usUsagePage: USAGE_PAGE_GENERIC,
                usUsage: usage,
                dwFlags: RIDEV_REMOVE,
                hwndTarget: HWND::default(),
            });
            let _ = RegisterRawInputDevices(&list, std::mem::size_of::<RAWINPUTDEVICE>() as u32);
        }
        if !hook.0.is_null() {
            let _ = UnhookWinEvent(hook);
        }
        if let Some(w) = window {
            let _ = DestroyWindow(w);
        }
        let _ = UnregisterClassW(w!("NamzuWinMonitor"), None);
    }
}
