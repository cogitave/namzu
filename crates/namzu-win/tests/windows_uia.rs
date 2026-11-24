//! The helper against a real window, on Windows only.
//!
//! The test starts the helper as a program, as the CLI does, and talks to it
//! over its standard input and output. It makes one window of its own (an
//! ordinary top-level window holding a button), so nothing outside the test
//! is read or touched, and then asks the helper what it sees: the window in
//! the list, its controls, a control's identity and the control found again,
//! and a change the test makes to the button being waited for.
//!
//! Replies are awaited by reading the helper's output until the id arrives;
//! a helper that hangs is ended by the job's own limit, not by a clock here.
#![cfg(windows)]

use namzu_win_core::fingerprint::name_hash;
use namzu_win_core::protocol::{
    self, ChangeKind, IdentityRequest, Op, ReplyBody, Request, Resolution, ResolveRequest,
    ResolveVia, SeqRequest, SnapshotRequest, WaitChangeRequest, WaitResult, WindowsRequest,
    WireError,
};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, DispatchMessageW, GetMessageW, MSG, PostThreadMessageW,
    SetWindowTextW, TranslateMessage, WINDOW_EX_STYLE, WM_QUIT, WS_CHILD, WS_OVERLAPPEDWINDOW,
    WS_VISIBLE,
};
use windows::core::w;

const TITLE: &str = "Namzu helper test window";
const BUTTON: &str = "Namzu test button";

/// The test's own window, on a thread that pumps its messages.
struct TestWindow {
    button: isize,
    thread_id: u32,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl TestWindow {
    fn open() -> TestWindow {
        let (tx, rx) = channel::<(isize, isize, u32)>();
        let thread = std::thread::spawn(move || unsafe {
            let parent = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!("Namzu helper test window"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                60,
                60,
                420,
                240,
                None,
                None,
                None,
                None,
            )
            .expect("create the test window");
            let button = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("BUTTON"),
                w!("Namzu test button"),
                WS_CHILD | WS_VISIBLE,
                10,
                10,
                180,
                32,
                Some(parent),
                None,
                None,
                None,
            )
            .expect("create the test button");
            tx.send((parent.0 as isize, button.0 as isize, GetCurrentThreadId()))
                .unwrap();
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = DestroyWindow(parent);
        });
        let (_, button, thread_id) = rx.recv().unwrap();
        TestWindow {
            button,
            thread_id,
            thread: Some(thread),
        }
    }

    fn rename_button(&self, text: windows::core::PCWSTR) {
        unsafe {
            let _ = SetWindowTextW(HWND(self.button as *mut std::ffi::c_void), text);
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

/// The helper as a child process.
struct Helper {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    /// Replies that arrived while another id was awaited.
    parked: HashMap<u64, String>,
    next_id: u64,
}

impl Helper {
    fn start() -> Helper {
        let mut child = Command::new(env!("CARGO_BIN_EXE_namzu-win"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start namzu-win");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Helper {
            child,
            stdin,
            lines,
            parked: HashMap::new(),
            next_id: 1,
        }
    }

    /// Writes a request and returns its id without waiting for the answer.
    fn send(&mut self, request: &Request) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        writeln!(self.stdin, "{}", protocol::encode_request(id, request)).unwrap();
        self.stdin.flush().unwrap();
        id
    }

    fn await_reply(&mut self, id: u64, op: Op) -> Result<ReplyBody, WireError> {
        loop {
            let line = match self.parked.remove(&id) {
                Some(line) => line,
                None => {
                    let line = self.lines.recv().expect("the helper ended");
                    let value: serde_json::Value = serde_json::from_str(&line).unwrap();
                    let got = value["id"].as_u64().unwrap();
                    if got != id {
                        self.parked.insert(got, line);
                        continue;
                    }
                    line
                }
            };
            let (got, reply) = protocol::decode_reply(op, &line).expect("a reply the codec reads");
            assert_eq!(got, id);
            return reply;
        }
    }

    fn call(&mut self, request: Request) -> Result<ReplyBody, WireError> {
        let op = request.op();
        let id = self.send(&request);
        self.await_reply(id, op)
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.call(Request::Quit);
        let _ = self.child.wait();
    }
}

fn hello(h: &mut Helper) {
    let reply = h
        .call(Request::Hello(protocol::HelloRequest {
            protocol: protocol::PROTOCOL.to_owned(),
            cli_version: "test".to_owned(),
        }))
        .unwrap();
    let ReplyBody::Hello(hello) = reply else {
        panic!("{reply:?}")
    };
    assert_eq!(hello.dpi_awareness, "perMonitorV2");
    assert!(hello.os_build.parse::<u32>().is_ok(), "{}", hello.os_build);
    for cap in [
        "windows",
        "displays",
        "snapshot",
        "wait_change",
        "uia",
        "hooks",
    ] {
        assert!(hello.caps.iter().any(|c| c == cap), "missing cap {cap}");
    }
}

/// Everything in one test: the helper's event hook is per process, and the
/// steps build on each other (the read before the identity before the resolve).
#[test]
fn the_helper_reads_a_real_window() {
    let window = TestWindow::open();
    let mut h = Helper::start();
    hello(&mut h);

    // displays
    let ReplyBody::Displays(d) = h.call(Request::Displays).unwrap() else {
        panic!("displays")
    };
    assert!(!d.displays.is_empty());
    assert!(d.displays.iter().any(|x| x.primary));
    assert!(
        d.displays
            .iter()
            .all(|x| x.scale >= 1.0 && x.bounds.width > 0)
    );

    // the window is in the list
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
        .expect("the test window is listed");
    assert_eq!(ours.process_id, std::process::id());
    assert!(ours.bounds.width > 0 && !ours.minimized);
    let window_id = ours.window_id.clone();

    // a read of it
    let ReplyBody::Snapshot(snap) = h
        .call(Request::Snapshot(SnapshotRequest {
            window_id: window_id.clone(),
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
    assert!(snap.revision >= 1 && !snap.nodes.is_empty());
    assert_eq!(snap.nodes[0].parent, -1);
    let button = snap
        .nodes
        .iter()
        .find(|n| n.role == "Button" && n.name.as_deref() == Some(BUTTON))
        .unwrap_or_else(|| {
            panic!(
                "no button in {:?}",
                snap.nodes
                    .iter()
                    .map(|n| (&n.role, &n.name))
                    .collect::<Vec<_>>()
            )
        });
    assert!(
        button
            .reference
            .starts_with(&format!("r{}.", snap.revision))
    );
    assert!(button.bounds.width > 0 && button.enabled);

    // its identity
    let ReplyBody::Identity(identity) = h
        .call(Request::Identity(IdentityRequest {
            window_id: window_id.clone(),
            index: button.index,
            revision: Some(snap.revision),
        }))
        .unwrap()
    else {
        panic!("identity")
    };
    let fp = identity.fingerprint;
    assert_eq!(fp.role, "Button");
    assert_eq!(fp.name_hash, name_hash(BUTTON));
    assert!(fp.process_start > 0);
    assert!(!fp.runtime_id.is_empty(), "the control has a runtime id");

    // an identity of a read that is not the latest is refused
    let stale = h
        .call(Request::Identity(IdentityRequest {
            window_id: window_id.clone(),
            index: 0,
            revision: Some(snap.revision + 100),
        }))
        .unwrap_err();
    assert_eq!(stale.code, "stale_snapshot");

    // the control found again
    let ReplyBody::Resolve(found) = h
        .call(Request::Resolve(ResolveRequest {
            window_id: window_id.clone(),
            fingerprint: fp,
        }))
        .unwrap()
    else {
        panic!("resolve")
    };
    match found {
        Resolution::Found { via, .. } => {
            assert!(matches!(
                via,
                ResolveVia::RuntimeId | ResolveVia::AutomationId | ResolveVia::Name
            ));
        }
        other => panic!("{other:?}"),
    }

    // a window that is not there
    let gone = h
        .call(Request::Snapshot(SnapshotRequest {
            window_id: "w:00000000deadbeef:1".to_owned(),
            max_nodes: None,
            max_depth: None,
            skeleton: None,
            allow_chromium: None,
            timeout_ms: None,
        }))
        .unwrap_err();
    assert_eq!(gone.code, "not_found");

    // a change the test makes is waited for
    let ReplyBody::Seq(marker) = h
        .call(Request::Seq(SeqRequest {
            window_id: Some(window_id.clone()),
        }))
        .unwrap()
    else {
        panic!("seq")
    };
    window.rename_button(w!("Renamed by the test"));
    let ReplyBody::WaitChange(waited) = h
        .call(Request::WaitChange(WaitChangeRequest {
            window_id: window_id.clone(),
            since: Some(marker.seq),
            quiet_ms: Some(50),
            timeout_ms: Some(8_000),
            kinds: None,
        }))
        .unwrap()
    else {
        panic!("wait_change")
    };
    match waited {
        WaitResult::Changed { events, .. } => assert!(events >= 1),
        other => panic!("the change was not seen: {other:?}"),
    }

    // a wait that is cancelled answers `cancelled`
    let ReplyBody::Seq(now) = h
        .call(Request::Seq(SeqRequest { window_id: None }))
        .unwrap()
    else {
        panic!("seq")
    };
    let wait = h.send(&Request::WaitChange(WaitChangeRequest {
        window_id,
        since: Some(now.seq),
        quiet_ms: None,
        timeout_ms: Some(10_000),
        kinds: Some(vec![ChangeKind::Location]),
    }));
    let cancel = h.send(&Request::Cancel(protocol::CancelRequest { target: wait }));
    assert!(h.await_reply(cancel, Op::Cancel).is_ok());
    assert_eq!(
        h.await_reply(wait, Op::WaitChange).unwrap_err().code,
        "cancelled"
    );
}
