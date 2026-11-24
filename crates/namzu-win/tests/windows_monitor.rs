//! The monitor and the presence overlay on a real desktop, on Windows only.
//!
//! The test makes windows of its own and drives the helper as a program, as
//! the CLI does. Raw Input is told apart by what it does here: the helper's
//! own `SendInput` is input the system synthesised, so it must arrive as
//! `injected` and as a device class only, with nothing of what was typed.
//! A runner has no person at it, so a person's own input (`inputs`) stays
//! zero; the unit tests of `namzu-win-core` cover how it is counted.
//!
//! Where the test must wait for the helper's thread to see a message it asks
//! again without a deadline: a helper that never sees it is ended by the
//! job's own limit, and no outcome here depends on how long a pass takes.
#![cfg(windows)]

mod common;

use common::{Helper, hello};
use namzu_win_core::dpi::Point;
use namzu_win_core::foreground::{ForegroundSetRequest, LeaseBeginRequest, LeaseEndRequest};
use namzu_win_core::input::InputRequest;
use namzu_win_core::monitor::{
    Device, Kind, MonitorPollReply, MonitorPollRequest, MonitorStartRequest,
};
use namzu_win_core::presence::{PresenceActRequest, PresenceKind};
use namzu_win_core::protocol::{ReplyBody, Request};
use namzu_win_core::window_id;
use std::sync::mpsc::channel;
use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GWL_EXSTYLE, GetClassNameW,
    GetMessageW, GetWindowDisplayAffinity, GetWindowLongPtrW, GetWindowRect,
    GetWindowThreadProcessId, IsWindowVisible, MSG, PostThreadMessageW, RegisterClassExW,
    TranslateMessage, WDA_NONE, WINDOW_EX_STYLE, WM_QUIT, WNDCLASSEXW, WS_EX_APPWINDOW,
    WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_OVERLAPPEDWINDOW,
    WS_VISIBLE,
};
use windows::core::w;

unsafe extern "system" fn wnd_proc(
    h: HWND,
    m: u32,
    wp: WPARAM,
    lp: LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    unsafe { DefWindowProcW(h, m, wp, lp) }
}

/// A top-level window on its own thread, with its message loop.
struct TestWindow {
    hwnd: isize,
    thread_id: u32,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl TestWindow {
    fn new(x: i32) -> TestWindow {
        let (tx, rx) = channel();
        let thread = std::thread::spawn(move || unsafe {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(wnd_proc),
                lpszClassName: w!("NamzuHelperMonitorTest"),
                ..Default::default()
            };
            // The second window of the test registers the same class again, which fails and is fine.
            let _ = RegisterClassExW(&class);
            let h = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("NamzuHelperMonitorTest"),
                w!("Namzu monitor test window"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                x,
                60,
                400,
                300,
                None,
                None,
                None,
                None,
            )
            .expect("create the test window");
            tx.send((h.0 as isize, GetCurrentThreadId())).unwrap();
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = DestroyWindow(h);
        });
        let (hwnd, thread_id) = rx.recv().unwrap();
        TestWindow {
            hwnd,
            thread_id,
            thread: Some(thread),
        }
    }

    fn handle(&self) -> HWND {
        HWND(self.hwnd as *mut std::ffi::c_void)
    }

    fn id(&self) -> String {
        window_id::format(self.hwnd as u64, std::process::id())
    }

    fn center(&self) -> (i32, i32) {
        let mut r = RECT::default();
        unsafe {
            let _ = GetWindowRect(self.handle(), &mut r);
        }
        ((r.left + r.right) / 2, (r.top + r.bottom) / 2)
    }
}

impl Drop for TestWindow {
    fn drop(&mut self) {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn poll(h: &mut Helper, since: Option<u64>) -> MonitorPollReply {
    let ReplyBody::MonitorPoll(p) = h
        .call(Request::MonitorPoll(MonitorPollRequest { since }))
        .expect("monitor.poll")
    else {
        panic!("monitor.poll")
    };
    p
}

/// Asks again until `ready` holds for what the monitor has recorded since `since`.
fn poll_until(
    h: &mut Helper,
    since: Option<u64>,
    ready: impl Fn(&MonitorPollReply) -> bool,
) -> MonitorPollReply {
    loop {
        let p = poll(h, since);
        if ready(&p) {
            return p;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

fn class_of(h: HWND) -> String {
    let mut buf = [0u16; 64];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn overlay_window(value: u64) -> HWND {
    HWND(value as usize as *mut std::ffi::c_void)
}

#[test]
fn the_monitor_sees_input_without_its_content_and_the_overlay_is_plain_to_capture() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let a = TestWindow::new(40);
    let b = TestWindow::new(480);
    let mut h = Helper::start();
    let hi = hello(&mut h);
    for cap in ["monitor", "rawinput", "presence"] {
        assert!(hi.caps.iter().any(|c| c == cap), "missing cap {cap}");
    }

    // --- before the monitor runs ------------------------------------------------
    let refused = h
        .call(Request::MonitorPoll(MonitorPollRequest { since: None }))
        .unwrap_err();
    assert_eq!(refused.code, "bad_request");
    // A burst with no monitor says nothing about a person's input.
    let ReplyBody::LeaseBegin(_) = h
        .call(Request::LeaseBegin(LeaseBeginRequest::default()))
        .unwrap()
    else {
        panic!("lease.begin")
    };
    let ReplyBody::LeaseEnd(end) = h
        .call(Request::LeaseEnd(LeaseEndRequest {
            restore: false,
            keep_cursor: None,
            release: None,
        }))
        .unwrap()
    else {
        panic!("lease.end")
    };
    assert_eq!(end.inputs_during, None);

    // --- the monitor starts and says what it watches ------------------------------
    let ReplyBody::MonitorStart(started) = h
        .call(Request::MonitorStart(MonitorStartRequest::default()))
        .unwrap()
    else {
        panic!("monitor.start")
    };
    assert!(started.input, "raw input is registered");
    assert!(started.foreground, "the foreground hook is set");
    let ReplyBody::MonitorStart(again) = h
        .call(Request::MonitorStart(MonitorStartRequest::default()))
        .unwrap()
    else {
        panic!("monitor.start")
    };
    assert_eq!(again, started, "a second start changes nothing");

    // --- raw input: the helper's own SendInput arrives as synthesised, by device only -
    let base = poll(&mut h, None).seq;
    let ReplyBody::LeaseBegin(_) = h
        .call(Request::LeaseBegin(LeaseBeginRequest::default()))
        .unwrap()
    else {
        panic!("lease.begin")
    };
    let (x, y) = a.center();
    h.call(Request::Input(InputRequest::Click {
        x,
        y,
        button: None,
        count: None,
    }))
    .expect("click");
    let mouse = poll_until(&mut h, Some(base), |p| {
        p.events
            .iter()
            .any(|e| e.kind == Kind::Input && e.device == Some(Device::Mouse))
    });
    assert!(mouse.injected_inputs > 0);
    assert_eq!(mouse.inputs, 0, "no person is at a runner");
    assert!(
        mouse
            .events
            .iter()
            .filter(|e| e.kind == Kind::Input)
            .all(|e| e.injected == Some(true)),
        "{mouse:?}"
    );
    let typed = "qzxjk";
    h.call(Request::Input(InputRequest::Type { text: typed.into() }))
        .expect("type");
    // Characters typed as Unicode units are system packets that raw input does
    // not report as keyboard events; a key press with a virtual key is.
    h.call(Request::Input(InputRequest::Key {
        keys: "shift".into(),
    }))
    .expect("key");
    let keys = poll_until(&mut h, Some(base), |p| {
        p.events
            .iter()
            .any(|e| e.kind == Kind::Input && e.device == Some(Device::Keyboard))
    });
    let line = serde_json::to_string(&keys).unwrap();
    assert!(!line.contains(typed), "what was typed is not in {line}");
    assert!(
        !line.contains("\"key\"") && !line.contains("vkey") && !line.contains("scan"),
        "{line}"
    );
    // The burst counts a person's input only: the helper's own is left out.
    let ReplyBody::LeaseEnd(end) = h
        .call(Request::LeaseEnd(LeaseEndRequest {
            restore: false,
            keep_cursor: None,
            release: None,
        }))
        .unwrap()
    else {
        panic!("lease.end")
    };
    assert_eq!(end.inputs_during, Some(0));

    // --- foreground changes arrive --------------------------------------------------
    let mark = poll(&mut h, None).seq;
    let want_b = b.id();
    let ReplyBody::ForegroundSet(set_b) = h
        .call(Request::ForegroundSet(ForegroundSetRequest {
            window_id: want_b.clone(),
        }))
        .expect("foreground.set")
    else {
        panic!("foreground.set")
    };
    assert!(set_b.raised, "{set_b:?}");
    let seen_b = poll_until(&mut h, Some(mark), |p| {
        p.events
            .iter()
            .any(|e| e.kind == Kind::Foreground && e.window_id.as_deref() == Some(want_b.as_str()))
    });
    assert!(seen_b.foreground_changes > 0);
    let mark = seen_b.seq;
    let want_a = a.id();
    h.call(Request::ForegroundSet(ForegroundSetRequest {
        window_id: want_a.clone(),
    }))
    .expect("foreground.set");
    poll_until(&mut h, Some(mark), |p| {
        p.events
            .iter()
            .any(|e| e.kind == Kind::Foreground && e.window_id.as_deref() == Some(want_a.as_str()))
    });

    // --- stopping ----------------------------------------------------------------------
    h.call(Request::MonitorStop).expect("monitor.stop");
    let gone = h
        .call(Request::MonitorPoll(MonitorPollRequest { since: None }))
        .unwrap_err();
    assert_eq!(gone.code, "bad_request");
    let ReplyBody::MonitorStart(restarted) = h
        .call(Request::MonitorStart(MonitorStartRequest {
            hooks: Some(vec![namzu_win_core::monitor::Hook::Foreground]),
        }))
        .unwrap()
    else {
        panic!("monitor.start")
    };
    assert!(restarted.foreground && !restarted.input, "{restarted:?}");
    h.call(Request::MonitorStop).expect("monitor.stop");

    // --- the presence overlay ----------------------------------------------------------
    let (cx, cy) = a.center();
    let ReplyBody::PresenceAct(shown) = h
        .call(Request::PresenceAct(PresenceActRequest {
            window_id: a.id(),
            kind: PresenceKind::Click,
            at: Some(Point { x: cx, y: cy }),
        }))
        .expect("presence.act")
    else {
        panic!("presence.act")
    };
    let helper_pid = h.child.id();
    for (name, value) in [
        ("cursor", shown.cursor_window),
        ("frame", shown.frame_window),
    ] {
        let w = overlay_window(value);
        assert_eq!(class_of(w), "NamzuWinPresence", "{name}");
        let mut pid = 0u32;
        unsafe {
            GetWindowThreadProcessId(w, Some(&mut pid));
        }
        assert_eq!(pid, helper_pid, "{name} belongs to the helper");
        let ex = unsafe { GetWindowLongPtrW(w, GWL_EXSTYLE) } as u32;
        for (flag, what) in [
            (WS_EX_LAYERED.0, "layered"),
            (WS_EX_TRANSPARENT.0, "click-through"),
            (WS_EX_NOACTIVATE.0, "never activated"),
            (WS_EX_TOOLWINDOW.0, "a tool window"),
        ] {
            assert!(ex & flag != 0, "{name} is not {what}: {ex:#x}");
        }
        assert!(ex & WS_EX_APPWINDOW.0 == 0, "{name} stays off the taskbar");
        // The overlay is not hidden from screen capture.
        let mut affinity = 0u32;
        unsafe {
            GetWindowDisplayAffinity(w, &mut affinity).expect("read the display affinity");
        }
        assert_eq!(affinity, WDA_NONE.0, "{name} is excluded from capture");
        assert!(unsafe { IsWindowVisible(w).as_bool() }, "{name} is shown");
    }
    // The frame sits on the operated window.
    let mut want = RECT::default();
    unsafe {
        DwmGetWindowAttribute(
            a.handle(),
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut want as *mut RECT as *mut std::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
        .expect("the window's frame");
    }
    let mut got = RECT::default();
    unsafe {
        GetWindowRect(overlay_window(shown.frame_window), &mut got).expect("the frame's rectangle");
    }
    assert_eq!(
        (got.left, got.top, got.right, got.bottom),
        (want.left, want.top, want.right, want.bottom)
    );
    // A second action reuses the same two windows.
    let ReplyBody::PresenceAct(second) = h
        .call(Request::PresenceAct(PresenceActRequest {
            window_id: a.id(),
            kind: PresenceKind::Type,
            at: None,
        }))
        .unwrap()
    else {
        panic!("presence.act")
    };
    assert_eq!(second, shown);
    // A window that is gone is refused.
    let missing = h
        .call(Request::PresenceAct(PresenceActRequest {
            window_id: "w:0000000000000abc".into(),
            kind: PresenceKind::Click,
            at: None,
        }))
        .unwrap_err();
    assert_eq!(missing.code, "not_found");
    h.call(Request::PresenceHide).expect("presence.hide");
    for value in [shown.cursor_window, shown.frame_window] {
        assert!(
            !unsafe { IsWindowVisible(overlay_window(value)).as_bool() },
            "hidden"
        );
    }
}
