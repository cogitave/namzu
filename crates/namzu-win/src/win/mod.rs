//! The Windows backend: the calls behind `windows`, `displays`, `snapshot`,
//! `identity`, `resolve`, `seq` and `wait_change`.
//!
//! Three kinds of thread cooperate. The reader (the loop in `lib.rs`) answers
//! the cheap ops inline. One worker thread, in the multithreaded apartment,
//! runs every UI Automation call one after the other; a call that never
//! returns is answered `timeout` and the worker replaced (see `exec`). Two
//! more threads only listen: the hook thread (system window events) and the
//! wait scheduler. Events flow into the hub, which settles the waits.

mod enumerate;
mod hooks;
mod hub;
mod uia;

use crate::BuildInfo;
use crate::backend::{Backend, Responder, SharedResponder};
use crate::exec::{Abandon, SerialExecutor, Task};
use namzu_win_core::events::WaitSpec;
use namzu_win_core::fingerprint::{self, Candidate};
use namzu_win_core::protocol::{
    DisplaysReply, ErrorCode, IdentityReply, IdentityRequest, ReplyBody, Request, ResolveRequest,
    SeqReply, Snapshot, SnapshotRequest, WindowsReply, WireError,
};
use namzu_win_core::refs::{self, RefTable};
use namzu_win_core::tree;
use namzu_win_core::window_id;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows::Win32::UI::HiDpi::{
    AreDpiAwarenessContextsEqual, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    GetThreadDpiAwarenessContext, SetProcessDpiAwarenessContext,
};

use enumerate::{class_of, has_chromium, hwnd_from, hwnd_value, is_window, pid_of, process_start};
use hooks::Hooks;
use hub::Hub;
use uia::{El, Subscription, Uia};

/// Windows watched at once; the least recently used is let go past this.
const MAX_WATCHED: usize = 32;
/// Windows whose last read is kept so a ref can be used again.
const MAX_READS: usize = 6;
const DEFAULT_TASK_MS: u64 = 8_000;

struct Entry {
    #[expect(
        dead_code,
        reason = "kept so the act side can use the element a ref names without reading the window again"
    )]
    element: El,
    identity: fingerprint::Identity,
}

struct Watched {
    pid: u32,
    subscription: Option<Subscription>,
    used: u64,
}

#[derive(Default)]
struct Ui {
    refs: RefTable<Entry>,
    /// Windows with a read, oldest first.
    reads: Vec<String>,
    watched: HashMap<u64, Watched>,
    uses: u64,
}

struct Inner {
    exec: SerialExecutor,
    ui: Mutex<Ui>,
    uia: Mutex<Option<Arc<Uia>>>,
    hub: Arc<Hub>,
    hooks: Option<Hooks>,
    dpi_awareness: String,
}

pub struct WinBackend {
    inner: Arc<Inner>,
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

fn err(code: ErrorCode, message: impl Into<String>) -> WireError {
    WireError::new(code, message)
}

/// A UI Automation failure in the protocol's terms.
fn uia_error(e: &windows::core::Error) -> WireError {
    const ELEMENT_NOT_AVAILABLE: i32 = 0x8004_0201_u32 as i32;
    const ACCESS_DENIED: i32 = 0x8007_0005_u32 as i32;
    match e.code().0 {
        ELEMENT_NOT_AVAILABLE => err(ErrorCode::NotFound, "the window or control is gone"),
        ACCESS_DENIED => err(
            ErrorCode::ElevatedTarget,
            "the window belongs to a program with more rights than this one",
        ),
        other => err(
            ErrorCode::Internal,
            format!("UI Automation failed: 0x{:08x}", other as u32),
        ),
    }
}

/// The window an id names, if it is open and still belongs to the process the id says.
fn window_of(id: &str) -> Result<(HWND, u32), WireError> {
    let (value, pid) = window_id::parse(id).ok_or_else(|| {
        err(
            ErrorCode::BadRequest,
            "a window id looks like w:<handle>:<process>, as `windows` lists it",
        )
    })?;
    let hwnd = hwnd_from(value);
    if !is_window(hwnd) {
        return Err(err(ErrorCode::NotFound, "no such window"));
    }
    let actual = pid_of(hwnd);
    if pid.is_some_and(|p| p != actual) {
        return Err(err(
            ErrorCode::NotFound,
            "the window id is from a window that is gone",
        ));
    }
    Ok((hwnd, actual))
}

fn os_build() -> String {
    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    // SAFETY: `info` is sized as the call requires.
    let status = unsafe { windows::Wdk::System::SystemServices::RtlGetVersion(&mut info) };
    if status.0 == 0 {
        info.dwBuildNumber.to_string()
    } else {
        "unknown".to_owned()
    }
}

fn set_dpi_awareness() -> String {
    // SAFETY: plain calls with a constant context. A manifest may have set it already, so a failure is fine.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        if AreDpiAwarenessContextsEqual(
            GetThreadDpiAwarenessContext(),
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        )
        .as_bool()
        {
            "perMonitorV2".to_owned()
        } else {
            "other".to_owned()
        }
    }
}

impl WinBackend {
    pub fn new() -> WinBackend {
        let dpi_awareness = set_dpi_awareness();
        // Finer timer ticks, so a quiet period of 120 ms is not rounded to 125.
        // SAFETY: a plain call.
        unsafe {
            let _ = windows::Win32::Media::timeBeginPeriod(1);
        }
        let hub = Hub::new();
        let hooks = Hooks::start(Arc::clone(&hub));
        WinBackend {
            inner: Arc::new(Inner {
                exec: SerialExecutor::new(uia::init_thread),
                ui: Mutex::new(Ui::default()),
                uia: Mutex::new(None),
                hub,
                hooks,
                dpi_awareness,
            }),
        }
    }
}

impl Default for WinBackend {
    fn default() -> Self {
        WinBackend::new()
    }
}

impl Inner {
    /// The automation object, made on first use by a worker thread.
    fn uia(&self) -> Result<Arc<Uia>, WireError> {
        let mut slot = locked(&self.uia);
        if let Some(u) = slot.as_ref() {
            return Ok(Arc::clone(u));
        }
        let made = Uia::new().map_err(|e| uia_error(&e))?;
        let made = Arc::new(made);
        *slot = Some(Arc::clone(&made));
        Ok(made)
    }

    fn is_watched(&self, hwnd: u64) -> bool {
        let mut ui = locked(&self.ui);
        ui.uses += 1;
        let used = ui.uses;
        match ui.watched.get_mut(&hwnd) {
            Some(w) => {
                w.used = used;
                true
            }
            None => false,
        }
    }

    /// Starts watching a window (and its process) for changes. Worker thread only.
    fn watch(&self, window: HWND, pid: u32) -> Result<(), WireError> {
        let hwnd = hwnd_value(window);
        if self.is_watched(hwnd) {
            return Ok(());
        }
        let hooks = self
            .hooks
            .as_ref()
            .ok_or_else(|| err(ErrorCode::Internal, "the window event thread did not start"))?;
        if !hooks.ensure(pid) {
            return Err(err(ErrorCode::Internal, "could not watch the process"));
        }
        let uia = self.uia()?;
        // A browser-engine window is watched through system events only: asking it for
        // accessibility events would turn its accessibility on.
        let subscription = if window_id::is_chromium_class(&class_of(window)) {
            None
        } else {
            Some(
                uia.watch(window, &self.hub, hwnd, pid)
                    .map_err(|e| uia_error(&e))?,
            )
        };
        let dropped = {
            let mut ui = locked(&self.ui);
            ui.uses += 1;
            let used = ui.uses;
            ui.watched.insert(
                hwnd,
                Watched {
                    pid,
                    subscription,
                    used,
                },
            );
            let mut dropped: Vec<(u64, Watched)> = Vec::new();
            let gone: Vec<u64> = ui
                .watched
                .keys()
                .copied()
                .filter(|k| *k != hwnd && !is_window(hwnd_from(*k)))
                .collect();
            for k in gone {
                if let Some(w) = ui.watched.remove(&k) {
                    dropped.push((k, w));
                }
            }
            while ui.watched.len() > MAX_WATCHED {
                let oldest = ui
                    .watched
                    .iter()
                    .filter(|(k, _)| **k != hwnd)
                    .min_by_key(|(_, w)| w.used)
                    .map(|(k, _)| *k);
                let Some(k) = oldest else { break };
                if let Some(w) = ui.watched.remove(&k) {
                    dropped.push((k, w));
                }
            }
            dropped
        };
        for (_, w) in dropped {
            if let Some(s) = &w.subscription {
                uia.unwatch(s);
            }
            let still = locked(&self.ui).watched.values().any(|o| o.pid == w.pid);
            if !still {
                hooks.drop_pid(w.pid);
            }
        }
        Ok(())
    }

    /// Reads a window and keeps the read, so refs from it can be used and an identity asked of it.
    fn read(
        &self,
        window: HWND,
        pid: u32,
        max_nodes: u32,
        max_depth: u32,
        skeleton: bool,
    ) -> Result<(String, u64, tree::Walked<El>, f64), WireError> {
        let uia = self.uia()?;
        let started = Instant::now();
        let root = uia.element_from_window(window).map_err(|e| uia_error(&e))?;
        let source = uia.source();
        let mut walked = if skeleton {
            tree::skeleton(&source, &root, max_nodes)
        } else {
            let top = uia.read_subtree(&root).map_err(|e| uia_error(&e))?;
            tree::walk(&source, &top, max_nodes, max_depth)
        };
        let read_ms = started.elapsed().as_secs_f64() * 1000.0;
        let id = window_id::format(hwnd_value(window), pid);
        let entries: Vec<Entry> = walked
            .handles
            .iter()
            .cloned()
            .zip(walked.identities.iter().cloned())
            .map(|(element, identity)| Entry { element, identity })
            .collect();
        let revision = {
            let mut ui = locked(&self.ui);
            let revision = ui.refs.publish(&id, entries);
            ui.reads.retain(|w| *w != id);
            ui.reads.push(id.clone());
            while ui.reads.len() > MAX_READS {
                let old = ui.reads.remove(0);
                ui.refs.forget(&old);
            }
            revision
        };
        walked.set_revision(revision);
        Ok((id, revision, walked, read_ms))
    }

    fn snapshot(&self, r: &SnapshotRequest) -> Result<ReplyBody, WireError> {
        let (window, pid) = window_of(&r.window_id)?;
        if !r.allow_chromium.unwrap_or(false) && has_chromium(window) {
            return Err(err(
                ErrorCode::ChromiumNotActivated,
                "this window is a Chromium or Electron one; reading it would turn its accessibility on",
            ));
        }
        let skeleton = r.skeleton.unwrap_or(false);
        let (id, revision, walked, read_ms) =
            self.read(window, pid, r.max_nodes(), r.max_depth(), skeleton)?;
        Ok(ReplyBody::Snapshot(Snapshot {
            window_id: id,
            revision,
            nodes: walked.nodes,
            total: walked.total,
            truncated: walked.truncated,
            skeleton,
            read_ms,
        }))
    }

    fn identity(&self, r: &IdentityRequest) -> Result<ReplyBody, WireError> {
        let (window, pid) = window_of(&r.window_id)?;
        let id = window_id::format(hwnd_value(window), pid);
        let ui = locked(&self.ui);
        let current = ui
            .refs
            .current_revision(&id)
            .ok_or_else(|| err(ErrorCode::NotFound, "take a snapshot of the window first"))?;
        if r.revision.is_some_and(|rev| rev != current) {
            return Err(err(
                ErrorCode::StaleSnapshot,
                "the window was read again since",
            ));
        }
        let hit = ui
            .refs
            .get(&id, &refs::format_ref(current, r.index))
            .map_err(|e| err(ErrorCode::BadRequest, e.to_string()))?;
        let fp = hit.entry.identity.to_fingerprint(process_start(pid));
        Ok(ReplyBody::Identity(IdentityReply { fingerprint: fp }))
    }

    fn resolve(&self, r: &ResolveRequest) -> Result<ReplyBody, WireError> {
        let (window, pid) = window_of(&r.window_id)?;
        if !fingerprint::same_process_run(r.fingerprint.process_start, process_start(pid)) {
            return Ok(ReplyBody::Resolve(
                fingerprint::Match::NotFound.into_resolution(0),
            ));
        }
        let (_, revision, walked, _) = self.read(window, pid, 5_000, 64, false)?;
        let candidates: Vec<Candidate> = walked
            .identities
            .iter()
            .enumerate()
            .map(|(i, identity)| Candidate {
                index: i as u32,
                identity: identity.clone(),
            })
            .collect();
        let found = fingerprint::resolve(&r.fingerprint, &candidates);
        Ok(ReplyBody::Resolve(found.into_resolution(revision)))
    }
}

/// Runs `work` on the worker thread and answers with its result; a task that
/// is overdue or cancelled is answered `timeout` or `cancelled` instead.
fn submit(
    inner: &Arc<Inner>,
    id: u64,
    timeout_ms: u64,
    responder: SharedResponder,
    work: impl FnOnce(&Inner) -> Result<ReplyBody, WireError> + Send + 'static,
) {
    let on_abandon = responder.clone();
    let worker_inner = Arc::clone(inner);
    inner.exec.submit(Task {
        id,
        timeout: Duration::from_millis(timeout_ms),
        run: Box::new(move || {
            responder.send(work(&worker_inner));
        }),
        abandon: Box::new(move |why| match why {
            Abandon::Timeout => {
                on_abandon.fail(ErrorCode::Timeout, "the window did not answer in time");
            }
            Abandon::Cancelled => {
                on_abandon.fail(ErrorCode::Cancelled, "cancelled");
            }
        }),
    });
}

impl Backend for WinBackend {
    fn describe(&self, info: &mut BuildInfo) {
        info.os_build = os_build();
        info.dpi_awareness = self.inner.dpi_awareness.clone();
        info.caps = [
            "windows",
            "displays",
            "snapshot",
            "identity",
            "resolve",
            "seq",
            "wait_change",
            "uia",
            "hooks",
        ]
        .iter()
        .map(|c| (*c).to_owned())
        .collect();
    }

    fn start(&self, request: Request, responder: Responder) {
        let inner = &self.inner;
        let id = responder.id();
        match request {
            Request::Windows(r) => {
                responder.ok(ReplyBody::Windows(WindowsReply {
                    windows: enumerate::windows(r.include_owned.unwrap_or(false)),
                }));
            }
            Request::Displays => {
                responder.ok(ReplyBody::Displays(DisplaysReply {
                    displays: enumerate::displays(),
                }));
            }
            Request::Snapshot(r) => {
                let timeout = r.timeout_ms();
                submit(
                    inner,
                    id,
                    timeout,
                    SharedResponder::new(responder),
                    move |i| i.snapshot(&r),
                );
            }
            Request::Identity(r) => {
                submit(
                    inner,
                    id,
                    DEFAULT_TASK_MS,
                    SharedResponder::new(responder),
                    move |i| i.identity(&r),
                );
            }
            Request::Resolve(r) => {
                submit(
                    inner,
                    id,
                    DEFAULT_TASK_MS,
                    SharedResponder::new(responder),
                    move |i| i.resolve(&r),
                );
            }
            Request::Seq(r) => {
                let seq_now = |i: &Inner| ReplyBody::Seq(SeqReply { seq: i.hub.seq() });
                let Some(window_text) = r.window_id else {
                    responder.ok(seq_now(inner.as_ref()));
                    return;
                };
                let (window, pid) = match window_of(&window_text) {
                    Ok(w) => w,
                    Err(e) => return responder.send(Err(e)),
                };
                if inner.is_watched(hwnd_value(window)) {
                    responder.ok(seq_now(inner.as_ref()));
                    return;
                }
                // The first look at a window starts watching it, which takes a moment.
                let handle = hwnd_value(window);
                submit(
                    inner,
                    id,
                    DEFAULT_TASK_MS,
                    SharedResponder::new(responder),
                    move |i| {
                        i.watch(hwnd_from(handle), pid)?;
                        Ok(seq_now(i))
                    },
                );
            }
            Request::WaitChange(r) => {
                let (window, pid) = match window_of(&r.window_id) {
                    Ok(w) => w,
                    Err(e) => return responder.send(Err(e)),
                };
                let hwnd = hwnd_value(window);
                let shared = SharedResponder::new(responder);
                let spec = WaitSpec {
                    hwnd,
                    pid,
                    since: r.since,
                    quiet_ms: r.quiet_ms(),
                    timeout_ms: r.timeout_ms(),
                    kinds: r.kinds(),
                };
                inner.hub.add_wait(id, &spec, shared);
                if !inner.is_watched(hwnd) {
                    // Armed behind the wait; the wait still ends on time.
                    let waiting = Arc::clone(inner);
                    let abandoned = Arc::clone(inner);
                    inner.exec.submit(Task {
                        id: 0,
                        timeout: Duration::from_millis(DEFAULT_TASK_MS),
                        run: Box::new(move || {
                            if let Err(e) = waiting.watch(hwnd_from(hwnd), pid) {
                                waiting.hub.end_wait(id, e);
                            }
                        }),
                        abandon: Box::new(move |_| {
                            abandoned.hub.end_wait(
                                id,
                                err(ErrorCode::Timeout, "the window did not answer in time"),
                            );
                        }),
                    });
                }
            }
            // Answered by the loop before they get here.
            Request::Hello(_) | Request::Cancel(_) | Request::Quit => {
                responder.fail(ErrorCode::Internal, "this op is answered by the loop");
            }
        }
    }

    fn cancel(&self, target: u64) {
        self.inner.exec.cancel(target);
        self.inner
            .hub
            .end_wait(target, err(ErrorCode::Cancelled, "cancelled"));
    }
}
