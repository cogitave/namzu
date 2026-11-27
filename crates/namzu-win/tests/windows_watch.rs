//! The watch on a real desktop, on Windows only.
//!
//! The test makes a window of its own with two standard edit controls, one of
//! them a password field, and drives the helper as a program, as the CLI does.
//! It holds the helper to what the design promises: an ordinary edit control
//! reports its text, a password field reports `secure` and never a value, and
//! nothing about keys or the mouse is in any event.
//!
//! Waits ask again with a generous bound (`WAIT_BOUND`) after which the test
//! panics naming the section and the last reply: a healthy runner needs
//! milliseconds, so the bound only turns a hang into a fast, explained failure.
#![cfg(windows)]

mod common;

use common::{Helper, hello};
use namzu_win_core::protocol::{ReplyBody, Request};
use namzu_win_core::watch::{WatchEvent, WatchKind, WatchStartRequest};
use std::sync::mpsc::channel;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, ES_PASSWORD, GetMessageW,
    MSG, PostThreadMessageW, RegisterClassExW, SetWindowTextW, TranslateMessage, WINDOW_EX_STYLE,
    WINDOW_STYLE, WM_QUIT, WNDCLASSEXW, WS_CHILD, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};
use windows::core::{PCWSTR, w};

unsafe extern "system" fn wnd_proc(
    h: HWND,
    m: u32,
    wp: WPARAM,
    lp: LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    unsafe { DefWindowProcW(h, m, wp, lp) }
}

/// A top-level window on its own thread with an ordinary and a password edit control.
struct TestWindow {
    plain: isize,
    secret: isize,
    thread_id: u32,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl TestWindow {
    fn new() -> TestWindow {
        let (tx, rx) = channel();
        let thread = std::thread::spawn(move || unsafe {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(wnd_proc),
                lpszClassName: w!("NamzuHelperWatchTest"),
                ..Default::default()
            };
            let _ = RegisterClassExW(&class);
            let top = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("NamzuHelperWatchTest"),
                w!("Namzu watch test window"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                40,
                60,
                420,
                200,
                None,
                None,
                None,
                None,
            )
            .expect("create the test window");
            let edit = |y: i32, extra: WINDOW_STYLE| {
                CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("EDIT"),
                    PCWSTR::null(),
                    WS_CHILD | WS_VISIBLE | extra,
                    10,
                    y,
                    300,
                    28,
                    Some(top),
                    None,
                    None,
                    None,
                )
                .expect("create an edit control")
            };
            let plain = edit(10, WINDOW_STYLE(0));
            let secret = edit(60, WINDOW_STYLE(ES_PASSWORD as u32));
            let _ = SetFocus(Some(plain));
            tx.send((plain.0 as isize, secret.0 as isize, GetCurrentThreadId()))
                .unwrap();
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = DestroyWindow(top);
        });
        let (plain, secret, thread_id) = rx.recv().unwrap();
        TestWindow {
            plain,
            secret,
            thread_id,
            thread: Some(thread),
        }
    }

    fn set(&self, which: isize, text: &str) {
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: the handle is a control of this test and the text is NUL-terminated.
        unsafe {
            let _ = SetWindowTextW(HWND(which as *mut std::ffi::c_void), PCWSTR(wide.as_ptr()));
        }
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

const WAIT_BOUND: std::time::Duration = std::time::Duration::from_secs(90);

fn poll(h: &mut Helper) -> namzu_win_core::watch::WatchPollReply {
    let ReplyBody::WatchPoll(p) = h
        .call(Request::WatchPoll(Default::default()))
        .expect("watch.poll")
    else {
        panic!("watch.poll")
    };
    p
}

/// Changes the control's text again and again, and collects what the watch
/// reports, until `ready` holds for everything seen or the bound passes.
fn drive_until(
    h: &mut Helper,
    section: &str,
    change: impl Fn(u32),
    ready: impl Fn(&[WatchEvent]) -> bool,
) -> Vec<WatchEvent> {
    let started = std::time::Instant::now();
    let mut seen = Vec::new();
    let mut n = 0;
    loop {
        n += 1;
        change(n);
        seen.extend(poll(h).events);
        if ready(&seen) {
            return seen;
        }
        if started.elapsed() > WAIT_BOUND {
            panic!("HANG in section `{section}`: nothing after {WAIT_BOUND:?}; seen: {seen:?}");
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[test]
fn an_edit_control_reports_its_text_and_a_password_field_only_that_it_is_one() {
    let window = TestWindow::new();
    let mut h = Helper::start();
    let hi = hello(&mut h);
    assert!(hi.caps.iter().any(|c| c == "watch"), "missing cap watch");

    // Before the watch runs there is nothing to poll.
    let refused = h.call(Request::WatchPoll(Default::default())).unwrap_err();
    assert_eq!(refused.code, "bad_request");

    let ReplyBody::WatchStart(started) = h
        .call(Request::WatchStart(WatchStartRequest {
            kinds: Some(vec![WatchKind::Value, WatchKind::Focus]),
            coalesce_ms: Some(0),
            ..Default::default()
        }))
        .expect("watch.start")
    else {
        panic!("watch.start")
    };
    assert!(started.controls, "UI Automation subscriptions came up");
    assert_eq!(started.kinds, vec![WatchKind::Value, WatchKind::Focus]);

    let typed = drive_until(
        &mut h,
        "an ordinary edit control",
        |n| window.set(window.plain, &format!("hello {n}")),
        |seen| {
            seen.iter().any(|e| {
                e.kind == WatchKind::Value
                    && e.role.as_deref() == Some("Edit")
                    && e.value.as_deref().is_some_and(|v| v.starts_with("hello"))
            })
        },
    );
    assert!(typed.iter().all(|e| !e.secure));

    let secret = drive_until(
        &mut h,
        "a password field",
        |n| window.set(window.secret, &format!("hunter{n}")),
        |seen| seen.iter().any(|e| e.secure),
    );
    for e in &secret {
        assert_eq!(e.value.as_deref().filter(|_| e.secure), None);
        let json = serde_json::to_string(e).unwrap();
        assert!(
            !json.contains("hunter"),
            "a password's text left the helper: {json}"
        );
    }

    h.call(Request::WatchStop).expect("watch.stop");
    let again = h.call(Request::WatchPoll(Default::default())).unwrap_err();
    assert_eq!(again.code, "bad_request");
    // Stopping twice is fine.
    h.call(Request::WatchStop).expect("watch.stop twice");
}
