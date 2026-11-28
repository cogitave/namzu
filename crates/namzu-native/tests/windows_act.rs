//! The helper acting on a real window, on Windows only: patterns, input,
//! pictures, the foreground and the lease.
//!
//! The test makes one window of its own (a class with a window procedure that
//! records what reaches it: button commands, text changes, mouse presses and
//! the wheel) with a push button, a check box, a button that is turned off, a
//! text box and a list, and then drives the helper as a program, as the CLI
//! does. Every effect is seen where it lands: in the window procedure, which
//! signals the test, so the test waits for the event itself and never for a
//! time. A helper that hangs is ended by the job's own limit.
#![cfg(windows)]

mod common;

use common::{Helper, hello};
use namzu_native_core::act::{ActKind, ActRequest};
use namzu_native_core::bytes::sha256_hex;
use namzu_native_core::capture::{CaptureRequest, CaptureTarget, INLINE_LIMIT, png_size};
use namzu_native_core::foreground::{
    ForegroundGetRequest, ForegroundSetRequest, LeaseBeginRequest, LeaseEndRequest,
};
use namzu_native_core::input::{InputRequest, ScrollDirection};
use namzu_native_core::protocol::{
    IdentityRequest, MouseButton, Node, ReplyBody, Request, SnapshotRequest, WindowsRequest,
};
use std::sync::mpsc::channel;
use std::sync::{Condvar, LazyLock, Mutex, MutexGuard};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::ClientToScreen;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CS_DBLCLKS, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetDlgItem,
    GetMessageW, GetWindowTextW, HMENU, LB_ADDSTRING, LB_GETTOPINDEX, MSG, PostThreadMessageW,
    RegisterClassExW, SW_MINIMIZE, SW_RESTORE, SendMessageW, ShowWindow, TranslateMessage,
    WINDOW_EX_STYLE, WINDOW_STYLE, WM_COMMAND, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MOUSEWHEEL, WM_QUIT, WM_RBUTTONDOWN, WM_SETTEXT, WNDCLASSEXW, WS_BORDER, WS_CHILD,
    WS_DISABLED, WS_OVERLAPPEDWINDOW, WS_TABSTOP, WS_VISIBLE, WS_VSCROLL,
};
use windows::core::w;

const TITLE: &str = "Namzu act test window";
const ID_PUSH: usize = 101;
const ID_CHECK: usize = 102;
const ID_EDIT: usize = 104;
const EN_CHANGE: usize = 0x0300;

/// What reached the window, and a signal for the test to wake on.
#[derive(Default)]
struct Seen {
    invoked: u32,
    checked: u32,
    downs: Vec<(i32, i32)>,
    ups: Vec<(i32, i32)>,
    doubles: u32,
    rights: u32,
    wheel: Vec<i16>,
    text: String,
}

static SEEN: LazyLock<(Mutex<Seen>, Condvar)> =
    LazyLock::new(|| (Mutex::new(Seen::default()), Condvar::new()));

fn seen() -> MutexGuard<'static, Seen> {
    SEEN.0.lock().unwrap_or_else(|p| p.into_inner())
}

fn record(f: impl FnOnce(&mut Seen)) {
    f(&mut seen());
    SEEN.1.notify_all();
}

/// Blocks until `ready` holds for what the window has seen.
fn wait_until(ready: impl Fn(&Seen) -> bool) {
    let guard = seen();
    let _ready = SEEN
        .1
        .wait_while(guard, |s| !ready(s))
        .unwrap_or_else(|p| p.into_inner());
}

fn point(lparam: LPARAM) -> (i32, i32) {
    (
        (lparam.0 & 0xFFFF) as u16 as i16 as i32,
        ((lparam.0 >> 16) & 0xFFFF) as u16 as i16 as i32,
    )
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_COMMAND => {
            let id = wparam.0 & 0xFFFF;
            let code = (wparam.0 >> 16) & 0xFFFF;
            if id == ID_EDIT && code == EN_CHANGE {
                let edit = HWND(lparam.0 as *mut std::ffi::c_void);
                let mut buf = [0u16; 512];
                let n = unsafe { GetWindowTextW(edit, &mut buf) }.max(0) as usize;
                record(|s| s.text = String::from_utf16_lossy(&buf[..n]));
            } else if code == 0 && id == ID_PUSH {
                record(|s| s.invoked += 1);
            } else if code == 0 && id == ID_CHECK {
                record(|s| s.checked += 1);
            }
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            record(|s| s.downs.push(point(lparam)));
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            record(|s| s.ups.push(point(lparam)));
            LRESULT(0)
        }
        WM_LBUTTONDBLCLK => {
            record(|s| s.doubles += 1);
            LRESULT(0)
        }
        WM_RBUTTONDOWN => {
            record(|s| s.rights += 1);
            LRESULT(0)
        }
        WM_MOUSEWHEEL => {
            let delta = ((wparam.0 >> 16) & 0xFFFF) as u16 as i16;
            record(|s| s.wheel.push(delta));
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

struct TestWindow {
    parent: isize,
    list: isize,
    thread_id: u32,
    thread: Option<std::thread::JoinHandle<()>>,
}

fn child(
    class: windows::core::PCWSTR,
    text: windows::core::PCWSTR,
    style: i32,
    extra: WINDOW_STYLE,
    (x, y, w, h): (i32, i32, i32, i32),
    parent: HWND,
    id: usize,
) -> HWND {
    unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            text,
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | extra | WINDOW_STYLE(style as u32),
            x,
            y,
            w,
            h,
            Some(parent),
            Some(HMENU(id as *mut std::ffi::c_void)),
            None,
            None,
        )
        .expect("create a control")
    }
}

impl TestWindow {
    fn open() -> TestWindow {
        let (tx, rx) = channel::<(isize, isize, u32)>();
        let thread = std::thread::spawn(move || unsafe {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: CS_DBLCLKS,
                lpfnWndProc: Some(wnd_proc),
                lpszClassName: w!("NamzuHelperActTest"),
                ..Default::default()
            };
            assert_ne!(RegisterClassExW(&class), 0, "register the window class");
            let parent = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("NamzuHelperActTest"),
                w!("Namzu act test window"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                40,
                40,
                520,
                420,
                None,
                None,
                None,
                None,
            )
            .expect("create the test window");
            child(
                w!("BUTTON"),
                w!("Press me"),
                0,
                WINDOW_STYLE(0),
                (10, 10, 150, 30),
                parent,
                ID_PUSH,
            );
            child(
                w!("BUTTON"),
                w!("Check me"),
                3,
                WINDOW_STYLE(0),
                (10, 50, 150, 24),
                parent,
                ID_CHECK,
            );
            child(
                w!("BUTTON"),
                w!("Off button"),
                0,
                WS_DISABLED,
                (10, 84, 150, 30),
                parent,
                103,
            );
            child(
                w!("EDIT"),
                w!(""),
                128,
                WS_BORDER,
                (10, 124, 250, 26),
                parent,
                ID_EDIT,
            );
            let list = child(
                w!("LISTBOX"),
                w!(""),
                1,
                WS_BORDER | WS_VSCROLL,
                (10, 160, 250, 100),
                parent,
                105,
            );
            for i in 0..20 {
                let text: Vec<u16> = format!("Item {i}\0").encode_utf16().collect();
                SendMessageW(
                    list,
                    LB_ADDSTRING,
                    None,
                    Some(LPARAM(text.as_ptr() as isize)),
                );
            }
            tx.send((parent.0 as isize, list.0 as isize, GetCurrentThreadId()))
                .unwrap();
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = DestroyWindow(parent);
        });
        let (parent, list, thread_id) = rx.recv().unwrap();
        TestWindow {
            parent,
            list,
            thread_id,
            thread: Some(thread),
        }
    }

    /// A point of the window's own client area, as a screen point.
    fn screen(&self, x: i32, y: i32) -> (i32, i32) {
        let mut p = POINT { x, y };
        unsafe {
            let _ = ClientToScreen(HWND(self.parent as *mut std::ffi::c_void), &mut p);
        }
        (p.x, p.y)
    }

    fn top_index(&self) -> isize {
        unsafe {
            SendMessageW(
                HWND(self.list as *mut std::ffi::c_void),
                LB_GETTOPINDEX,
                None,
                None,
            )
            .0
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

fn snapshot(h: &mut Helper, window_id: &str) -> (u64, Vec<Node>) {
    let ReplyBody::Snapshot(snap) = h
        .call(Request::Snapshot(SnapshotRequest {
            window_id: window_id.to_owned(),
            max_nodes: None,
            max_depth: None,
            skeleton: None,
            allow_chromium: None,
            timeout_ms: None,
        }))
        .unwrap()
    else {
        panic!("snapshot")
    };
    (snap.revision, snap.nodes)
}

fn named<'a>(nodes: &'a [Node], role: &str, name: &str) -> &'a Node {
    nodes
        .iter()
        .find(|n| n.role == role && n.name.as_deref() == Some(name))
        .unwrap_or_else(|| {
            panic!(
                "no {role} {name:?} in {:?}",
                nodes.iter().map(|n| (&n.role, &n.name)).collect::<Vec<_>>()
            )
        })
}

fn act(
    h: &mut Helper,
    window_id: &str,
    reference: &str,
    action: ActKind,
) -> Result<namzu_native_core::act::ActReply, namzu_native_core::protocol::WireError> {
    act_with(h, window_id, reference, action, None, None, None)
}

fn act_with(
    h: &mut Helper,
    window_id: &str,
    reference: &str,
    action: ActKind,
    text: Option<&str>,
    dx: Option<i32>,
    dy: Option<i32>,
) -> Result<namzu_native_core::act::ActReply, namzu_native_core::protocol::WireError> {
    h.call(Request::Act(ActRequest {
        window_id: window_id.to_owned(),
        reference: Some(reference.to_owned()),
        fingerprint: None,
        action,
        text: text.map(str::to_owned),
        dx,
        dy,
        timeout_ms: None,
    }))
    .map(|body| match body {
        ReplyBody::Act(a) => a,
        other => panic!("act: {other:?}"),
    })
}

fn input(h: &mut Helper, request: InputRequest) -> namzu_native_core::input::InputReply {
    match h.call(Request::Input(request)).expect("input") {
        ReplyBody::Input(i) => i,
        other => panic!("input: {other:?}"),
    }
}

fn click(h: &mut Helper, at: (i32, i32)) {
    input(
        h,
        InputRequest::Click {
            x: at.0,
            y: at.1,
            button: None,
            count: None,
        },
    );
}

fn center(n: &Node) -> (i32, i32) {
    (
        n.bounds.x + n.bounds.width / 2,
        n.bounds.y + n.bounds.height / 2,
    )
}

fn capture(
    h: &mut Helper,
    target: CaptureTarget,
    into: Option<&str>,
    inline: bool,
) -> namzu_native_core::capture::CaptureReply {
    let reply = h
        .call(Request::Capture(CaptureRequest {
            target,
            into: into.map(str::to_owned),
            inline: inline.then_some(true),
            cursor: None,
            timeout_ms: None,
        }))
        .expect("capture");
    match reply {
        ReplyBody::Capture(c) => c,
        other => panic!("capture: {other:?}"),
    }
}

/// Everything in one test: the steps share one helper, one window, one pointer
/// and one keyboard, and input must not run beside other input.
#[test]
fn the_helper_acts_on_a_real_window() {
    // The test's own coordinates must be physical pixels, like the helper's.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let window = TestWindow::open();
    let mut h = Helper::start();
    hello(&mut h);

    let ReplyBody::Windows(list) = h
        .call(Request::Windows(WindowsRequest {
            include_owned: Some(true),
        }))
        .unwrap()
    else {
        panic!("windows")
    };
    let ours = list
        .windows
        .iter()
        .find(|w| w.title == TITLE)
        .expect("the test window is listed")
        .clone();
    let id = ours.window_id.clone();
    let (revision, nodes) = snapshot(&mut h, &id);

    // --- act, by pattern ------------------------------------------------------
    let push = named(&nodes, "Button", "Press me");
    let done = act(&mut h, &id, &push.reference, ActKind::Invoke).expect("invoke");
    assert!(done.done);
    assert_eq!((done.index, done.revision), (push.index, revision));
    wait_until(|s| s.invoked >= 1);

    let check = named(&nodes, "CheckBox", "Check me");
    let toggled = act(&mut h, &id, &check.reference, ActKind::Toggle).expect("toggle");
    assert_eq!(toggled.verified, Some(true), "{toggled:?}");
    assert_eq!(
        toggled.after.as_ref().and_then(|a| a.toggle),
        Some(namzu_native_core::protocol::ToggleState::On)
    );
    wait_until(|s| s.checked >= 1);

    let edit = nodes
        .iter()
        .find(|n| n.role == "Edit")
        .expect("the text box");
    let typed = act_with(
        &mut h,
        &id,
        &edit.reference,
        ActKind::SetValue,
        Some("hello native"),
        None,
        None,
    )
    .expect("setValue");
    assert_eq!(typed.verified, Some(true), "{typed:?}");
    assert_eq!(
        typed.after.as_ref().and_then(|a| a.value.as_deref()),
        Some("hello native")
    );
    wait_until(|s| s.text == "hello native");

    let list_node = nodes.iter().find(|n| n.role == "List").expect("the list");
    let scroll = act_with(
        &mut h,
        &id,
        &list_node.reference,
        ActKind::Scroll,
        None,
        None,
        Some(3),
    );
    if list_node
        .actions
        .contains(&namzu_native_core::protocol::Action::Scroll)
    {
        assert!(scroll.expect("scroll").done);
        assert!(window.top_index() > 0, "the list did not scroll");
    } else {
        // A system whose list box offers no scroll pattern is refused, not clicked.
        assert_eq!(scroll.unwrap_err().code, "background_unavailable");
    }

    let item = named(&nodes, "ListItem", "Item 1");
    let selected = act(&mut h, &id, &item.reference, ActKind::Select).expect("select");
    assert_eq!(selected.verified, Some(true), "{selected:?}");

    // --- act, refused before anything is sent ---------------------------------
    let refused = |r: Result<_, namzu_native_core::protocol::WireError>, code: &str| match r {
        Err(e) => assert_eq!(e.code, code, "{}", e.message),
        Ok(other) => panic!("expected {code}, got {other:?}"),
    };
    // A text box is not pressed.
    refused(
        act(&mut h, &id, &edit.reference, ActKind::Invoke),
        "background_unavailable",
    );
    // A button that is turned off.
    let off = named(&nodes, "Button", "Off button");
    refused(
        act(&mut h, &id, &off.reference, ActKind::Invoke),
        "disabled",
    );
    // A ref from a read that was never made, and one that does not parse.
    refused(
        act(&mut h, &id, "r9999.0", ActKind::Invoke),
        "stale_snapshot",
    );
    refused(act(&mut h, &id, "nonsense", ActKind::Invoke), "bad_request");
    // setValue without text.
    refused(
        act(&mut h, &id, &edit.reference, ActKind::SetValue),
        "bad_request",
    );

    // --- act, by fingerprint after the window was read again --------------------
    let ReplyBody::Identity(identity) = h
        .call(Request::Identity(IdentityRequest {
            window_id: id.clone(),
            index: push.index,
            revision: None,
        }))
        .unwrap()
    else {
        panic!("identity")
    };
    let before = seen().invoked;
    let again = h
        .call(Request::Act(ActRequest {
            window_id: id.clone(),
            reference: None,
            fingerprint: Some(identity.fingerprint),
            action: ActKind::Invoke,
            text: None,
            dx: None,
            dy: None,
            timeout_ms: None,
        }))
        .expect("invoke by fingerprint");
    let ReplyBody::Act(again) = again else {
        panic!("act")
    };
    assert!(again.revision > revision, "a fresh read names the window");
    wait_until(|s| s.invoked > before);

    // --- input -----------------------------------------------------------------
    let (rev2, nodes) = snapshot(&mut h, &id);
    assert!(rev2 > revision);
    let edit = nodes
        .iter()
        .find(|n| n.role == "Edit")
        .expect("the text box");

    // Focus is not assumed: the helper brings the window forward as it can, and
    // the click below makes it the active one either way.
    let ReplyBody::ForegroundSet(raised) = h
        .call(Request::ForegroundSet(ForegroundSetRequest {
            window_id: id.clone(),
        }))
        .unwrap()
    else {
        panic!("foreground.set")
    };
    eprintln!("foreground.set: {raised:?}");

    let free = window.screen(400, 300);
    let downs = seen().downs.len();
    let moved = input(
        &mut h,
        InputRequest::Move {
            x: free.0,
            y: free.1,
        },
    );
    assert_eq!(moved.cursor.map(|p| (p.x, p.y)), Some(free));
    click(&mut h, free);
    wait_until(|s| s.downs.len() > downs);
    assert!(seen().downs.last().is_some());

    let rights = seen().rights;
    input(
        &mut h,
        InputRequest::Click {
            x: free.0,
            y: free.1,
            button: Some(MouseButton::Right),
            count: None,
        },
    );
    wait_until(|s| s.rights > rights);

    let doubles = seen().doubles;
    input(
        &mut h,
        InputRequest::Click {
            x: free.0,
            y: free.1,
            button: None,
            count: Some(2),
        },
    );
    wait_until(|s| s.doubles > doubles);

    let ups = seen().ups.len();
    let start = window.screen(300, 330);
    let end = window.screen(420, 330);
    input(
        &mut h,
        InputRequest::Drag {
            x: start.0,
            y: start.1,
            to_x: end.0,
            to_y: end.1,
            button: None,
        },
    );
    wait_until(|s| s.ups.len() > ups);
    {
        let s = seen();
        let (down, up) = (s.downs.last().unwrap(), s.ups.last().unwrap());
        assert_eq!(down.1, up.1);
        assert!((up.0 - down.0 - 120).abs() <= 2, "{down:?} -> {up:?}");
    }

    let wheels = seen().wheel.len();
    input(
        &mut h,
        InputRequest::Scroll {
            x: free.0,
            y: free.1,
            direction: ScrollDirection::Down,
            amount: Some(3),
        },
    );
    wait_until(|s| s.wheel.len() > wheels);
    assert_eq!(seen().wheel.last().copied(), Some(-360));

    // Typing goes where the pointer clicked: into the text box. A plain edit
    // control does not take ctrl+a as select-all on every system, so the box is
    // emptied by the window itself and the key is only checked to be delivered.
    unsafe {
        SendMessageW(
            GetDlgItem(
                Some(HWND(window.parent as *mut std::ffi::c_void)),
                ID_EDIT as i32,
            )
            .expect("the text box"),
            WM_SETTEXT,
            None,
            Some(LPARAM(w!("").as_ptr() as isize)),
        );
    }
    click(&mut h, center(edit));
    input(
        &mut h,
        InputRequest::Key {
            keys: "ctrl+a".into(),
        },
    );
    input(&mut h, InputRequest::Type { text: "xyz".into() });
    wait_until(|s| s.text == "xyz");
    input(
        &mut h,
        InputRequest::Key {
            keys: "backspace".into(),
        },
    );
    wait_until(|s| s.text == "xy");
    // A Unicode character the layout may not have.
    input(&mut h, InputRequest::Type { text: "é".into() });
    wait_until(|s| s.text == "xyé");

    // A point off every display is refused and nothing is sent.
    let off_screen = h
        .call(Request::Input(InputRequest::Click {
            x: 1_000_000,
            y: 0,
            button: None,
            count: None,
        }))
        .unwrap_err();
    assert_eq!(off_screen.code, "bad_request");

    // --- foreground ------------------------------------------------------------
    let ReplyBody::ForegroundGet(state) = h
        .call(Request::ForegroundGet(ForegroundGetRequest {
            window_id: Some(id.clone()),
            process_id: None,
        }))
        .unwrap()
    else {
        panic!("foreground.get")
    };
    assert!(state.foreground.is_some(), "{state:?}");
    assert!(state.self_integrity >= 0x1000, "{state:?}");
    assert!(state.target.is_some());
    assert!(state.user_idle_ms > 0);

    // --- the lease --------------------------------------------------------------
    let dir = std::env::temp_dir().join(format!("namzu-native-act-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let lease_file = dir.join("screen.lease");
    std::fs::write(&lease_file, r#"{"pid":1,"token":"tok-1"}"#).unwrap();
    let begin = |h: &mut Helper, ttl: Option<u64>| {
        h.call(Request::LeaseBegin(LeaseBeginRequest {
            window_id: Some(id.clone()),
            raise: None,
            idle_ms: None,
            ttl_ms: ttl,
            lease_path: Some(lease_file.to_string_lossy().into_owned()),
            token: Some("tok-1".into()),
        }))
    };
    let ReplyBody::LeaseBegin(held) = begin(&mut h, None).unwrap() else {
        panic!("lease.begin")
    };
    assert!(!held.refused);
    // One at a time.
    assert_eq!(begin(&mut h, None).unwrap_err().code, "lease_busy");
    // Input goes while the window is in front.
    click(&mut h, free);
    let ReplyBody::LeaseEnd(end) = h
        .call(Request::LeaseEnd(LeaseEndRequest {
            restore: false,
            keep_cursor: None,
            release: Some(true),
        }))
        .unwrap()
    else {
        panic!("lease.end")
    };
    assert!(end.released && !lease_file.exists());
    // Ending twice has nothing to end.
    assert_eq!(
        h.call(Request::LeaseEnd(LeaseEndRequest {
            restore: false,
            keep_cursor: None,
            release: None,
        }))
        .unwrap_err()
        .code,
        "bad_request"
    );

    // A lease that ran out lets nothing through.
    std::fs::write(&lease_file, r#"{"pid":1,"token":"tok-1"}"#).unwrap();
    begin(&mut h, Some(1)).unwrap();
    // The sleep only guarantees that the lease's millisecond has passed.
    std::thread::sleep(std::time::Duration::from_millis(30));
    let expired = h
        .call(Request::Input(InputRequest::Move {
            x: free.0,
            y: free.1,
        }))
        .unwrap_err();
    assert_eq!(expired.code, "lease_expired");
    // A new lease replaces the one that ran out.
    assert!(begin(&mut h, None).is_ok());

    // --- pictures ---------------------------------------------------------------
    let into = dir.to_string_lossy().into_owned();
    let shot = capture(
        &mut h,
        CaptureTarget::Window {
            window_id: id.clone(),
        },
        Some(&into),
        false,
    );
    let path = shot.path.clone().expect("a path");
    let file = std::fs::read(&path).expect("the picture is a file");
    assert_eq!(png_size(&file), Some((shot.width, shot.height)));
    assert_eq!(shot.bytes, file.len() as u64);
    assert_eq!(shot.sha256, sha256_hex(&file));
    assert!(shot.width >= 300 && shot.height >= 200, "{shot:?}");
    assert!(shot.scale >= 1.0);

    let displays = match h.call(Request::Displays).unwrap() {
        ReplyBody::Displays(d) => d.displays,
        other => panic!("{other:?}"),
    };
    let primary = displays
        .iter()
        .find(|d| d.primary)
        .expect("a primary display");
    let screen = capture(
        &mut h,
        CaptureTarget::Display { id: None },
        Some(&into),
        false,
    );
    assert_eq!(
        (screen.width as i32, screen.height as i32),
        (primary.bounds.width, primary.bounds.height)
    );
    assert_eq!(screen.display.as_deref(), Some(primary.id.as_str()));

    let region = capture(
        &mut h,
        CaptureTarget::Region {
            x: ours.bounds.x,
            y: ours.bounds.y,
            width: 100,
            height: 50,
        },
        Some(&into),
        false,
    );
    assert_eq!((region.width, region.height), (100, 50));

    let tiny = capture(
        &mut h,
        CaptureTarget::Region {
            x: ours.bounds.x,
            y: ours.bounds.y,
            width: 8,
            height: 8,
        },
        None,
        true,
    );
    let data = tiny.data_base64.expect("inline data");
    assert!(tiny.bytes as usize <= INLINE_LIMIT);
    assert_eq!(data.len() as u64, tiny.bytes.div_ceil(3) * 4);

    // A minimized window has no picture to take: it is said, not drawn as a
    // title-bar stub at the parking position.
    unsafe {
        let _ = ShowWindow(HWND(window.parent as *mut _), SW_MINIMIZE);
    }
    let minimized = h
        .call(Request::Capture(CaptureRequest {
            target: CaptureTarget::Window {
                window_id: id.clone(),
            },
            into: Some(into.clone()),
            inline: None,
            cursor: None,
            timeout_ms: None,
        }))
        .unwrap_err();
    assert_eq!(minimized.code, "background_unavailable", "{minimized:?}");
    unsafe {
        let _ = ShowWindow(HWND(window.parent as *mut _), SW_RESTORE);
    }

    // A picture needs a place to go.
    let nowhere = h
        .call(Request::Capture(CaptureRequest {
            target: CaptureTarget::Display { id: None },
            into: None,
            inline: None,
            cursor: None,
            timeout_ms: None,
        }))
        .unwrap_err();
    assert_eq!(nowhere.code, "bad_request");

    // --- the lease file goes with the helper ----------------------------------------
    // The lease begun above is still held: ending the helper ends it, and the
    // file it named goes, so a crash does not leave the screen locked.
    std::fs::write(&lease_file, r#"{"pid":1,"token":"tok-1"}"#).unwrap();
    // (The lease held now was begun with the same file and token.)
    drop(h);
    assert!(
        !lease_file.exists(),
        "the helper left the lease file behind"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
