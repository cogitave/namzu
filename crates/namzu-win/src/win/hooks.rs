//! System window events, scoped to the processes being watched.
//!
//! `SetWinEventHook` delivers to the thread that installed the hook through
//! its message loop, so one thread does nothing else: it installs and removes
//! hooks when asked and pumps messages. The callback records an event in the
//! hub and returns; it never asks the system anything slow.

use namzu_win_core::events::{Kind, Origin};
use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex, OnceLock};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetMessageW, MSG, PM_NOREMOVE, PeekMessageW, PostThreadMessageW,
    TranslateMessage, WM_APP,
};

use super::enumerate;
use super::hub::Hub;

const EVENT_OBJECT_CREATE: u32 = 0x8000;
const EVENT_OBJECT_DESTROY: u32 = 0x8001;
const EVENT_OBJECT_SHOW: u32 = 0x8002;
const EVENT_OBJECT_HIDE: u32 = 0x8003;
const EVENT_OBJECT_LOCATIONCHANGE: u32 = 0x800B;
const EVENT_OBJECT_NAMECHANGE: u32 = 0x800C;
const EVENT_OBJECT_VALUECHANGE: u32 = 0x800E;
/// Deliver on the hook thread, not inside the program that raised the event; skip this helper's own.
const WINEVENT_OUTOFCONTEXT_SKIPOWNPROCESS: u32 = 2;
const OBJID_CURSOR: i32 = -9;
const OBJID_CARET: i32 = -8;
/// The message that tells the hook thread to look at its command queue.
const WM_COMMANDS: u32 = WM_APP + 1;

/// What the callback needs, which a plain `extern "system"` function cannot be handed.
struct Ctx {
    hub: Arc<Hub>,
    /// Hook handle to the process it watches.
    pids: Mutex<HashMap<usize, u32>>,
}

static CTX: OnceLock<Ctx> = OnceLock::new();

enum Cmd {
    Install {
        pid: u32,
        done: Sender<Option<usize>>,
    },
    Remove {
        handle: usize,
        done: Sender<()>,
    },
}

pub struct Hooks {
    thread_id: u32,
    queue: Arc<Mutex<VecDeque<Cmd>>>,
    /// Process to hook handle.
    installed: Mutex<HashMap<u32, usize>>,
}

unsafe extern "system" fn on_event(
    hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    let Some(ctx) = CTX.get() else { return };
    let kind = match event {
        EVENT_OBJECT_CREATE => Kind::Created,
        EVENT_OBJECT_DESTROY => Kind::Destroyed,
        EVENT_OBJECT_SHOW => Kind::Shown,
        EVENT_OBJECT_HIDE => Kind::Hidden,
        EVENT_OBJECT_LOCATIONCHANGE => Kind::Location,
        EVENT_OBJECT_NAMECHANGE => Kind::Name,
        EVENT_OBJECT_VALUECHANGE => Kind::Value,
        _ => return,
    };
    if hwnd.0.is_null() || id_object == OBJID_CURSOR || id_object == OBJID_CARET {
        return;
    }
    let watched = ctx
        .pids
        .lock()
        .ok()
        .and_then(|m| m.get(&(hook.0 as usize)).copied());
    let pid = watched.unwrap_or_else(|| enumerate::pid_of(hwnd));
    let (root, gone) = enumerate::root(hwnd);
    let top = id_object == 0 && !gone && root == hwnd && enumerate::is_top_level(hwnd);
    ctx.hub.push(
        Origin::System,
        kind,
        enumerate::hwnd_value(hwnd),
        enumerate::hwnd_value(root),
        pid,
        top,
    );
}

impl Hooks {
    /// Starts the hook thread. `None` when it did not come up.
    pub fn start(hub: Arc<Hub>) -> Option<Hooks> {
        let _ = CTX.set(Ctx {
            hub,
            pids: Mutex::new(HashMap::new()),
        });
        let queue: Arc<Mutex<VecDeque<Cmd>>> = Arc::new(Mutex::new(VecDeque::new()));
        let (ready_tx, ready_rx) = channel::<u32>();
        let worker_queue = Arc::clone(&queue);
        std::thread::Builder::new()
            .name("namzu-win-hooks".to_owned())
            .spawn(move || pump(worker_queue, ready_tx))
            .ok()?;
        let thread_id = ready_rx.recv().ok()?;
        Some(Hooks {
            thread_id,
            queue,
            installed: Mutex::new(HashMap::new()),
        })
    }

    fn call<T>(&self, make: impl FnOnce(Sender<T>) -> Cmd) -> Option<T> {
        let (tx, rx) = channel();
        self.queue.lock().ok()?.push_back(make(tx));
        unsafe {
            PostThreadMessageW(self.thread_id, WM_COMMANDS, WPARAM(0), LPARAM(0)).ok()?;
        }
        rx.recv().ok()
    }

    /// Watches process `pid` if it is not watched yet. False when the hook could not be set.
    pub fn ensure(&self, pid: u32) -> bool {
        if self.installed.lock().is_ok_and(|m| m.contains_key(&pid)) {
            return true;
        }
        match self.call(|done| Cmd::Install { pid, done }).flatten() {
            Some(handle) => {
                if let Ok(mut m) = self.installed.lock() {
                    m.insert(pid, handle);
                }
                true
            }
            None => false,
        }
    }

    /// Stops watching process `pid`.
    pub fn drop_pid(&self, pid: u32) {
        let handle = self.installed.lock().ok().and_then(|mut m| m.remove(&pid));
        if let Some(handle) = handle {
            let _ = self.call(|done| Cmd::Remove { handle, done });
        }
    }
}

fn pump(queue: Arc<Mutex<VecDeque<Cmd>>>, ready: Sender<u32>) {
    unsafe {
        let mut msg = MSG::default();
        // Touching the queue creates it, so a message posted before the first read is kept.
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        let _ = ready.send(GetCurrentThreadId());
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            if msg.message == WM_COMMANDS {
                loop {
                    let next = queue.lock().ok().and_then(|mut q| q.pop_front());
                    let Some(cmd) = next else { break };
                    run(cmd);
                }
            } else {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
}

unsafe fn run(cmd: Cmd) {
    match cmd {
        Cmd::Install { pid, done } => {
            let handle = unsafe {
                SetWinEventHook(
                    EVENT_OBJECT_CREATE,
                    EVENT_OBJECT_VALUECHANGE,
                    None,
                    Some(on_event),
                    pid,
                    0,
                    WINEVENT_OUTOFCONTEXT_SKIPOWNPROCESS,
                )
            };
            if handle.0.is_null() {
                let _ = done.send(None);
            } else {
                let key = handle.0 as usize;
                if let Some(ctx) = CTX.get() {
                    if let Ok(mut m) = ctx.pids.lock() {
                        m.insert(key, pid);
                    }
                }
                let _ = done.send(Some(key));
            }
        }
        Cmd::Remove { handle, done } => {
            if let Some(ctx) = CTX.get() {
                if let Ok(mut m) = ctx.pids.lock() {
                    m.remove(&handle);
                }
            }
            unsafe {
                let _ = UnhookWinEvent(HWINEVENTHOOK(handle as *mut std::ffi::c_void));
            }
            let _ = done.send(());
        }
    }
}
