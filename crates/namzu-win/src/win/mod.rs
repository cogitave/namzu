//! The Windows backend: the calls behind `windows`, `displays`, `snapshot`,
//! `identity`, `resolve`, `seq`, `wait_change`, `act`, `input`, `capture`,
//! `foreground.get`, `foreground.set`, `lease.begin`, `lease.end`,
//! `monitor.start`, `monitor.stop`, `monitor.poll`, `presence.act` and
//! `presence.hide`.
//!
//! Three kinds of thread cooperate. The reader (the loop in `lib.rs`) answers
//! the cheap ops inline. Two worker threads, in the multithreaded apartment,
//! run the slow calls one after the other: one for UI Automation (reading,
//! acting), one for the screen (capture, input, foreground), so a picture or
//! a long text never waits behind a window that is slow to answer. A call
//! that never returns is answered `timeout` and its worker replaced (see
//! `exec`). Two more threads only listen: the hook thread (system window
//! events) and the wait scheduler. Events flow into the hub, which settles
//! the waits.

mod act;
mod capture;
mod enumerate;
mod foreground;
mod hooks;
mod hub;
mod monitor;
mod presence;
mod proc;
mod sendinput;
mod uia;

use crate::BuildInfo;
use crate::backend::{Backend, Responder, SharedResponder};
use crate::exec::{Abandon, SerialExecutor, Task};
use namzu_win_core::act::{ActReply, ActRequest, ActTarget, ActVia, Facts, Refusal};
use namzu_win_core::bytes::{base64, sha256_hex};
use namzu_win_core::capture::{
    CaptureReply, CaptureRequest, CaptureTarget, Delivery, INLINE_LIMIT,
};
use namzu_win_core::dpi;
use namzu_win_core::events::WaitSpec;
use namzu_win_core::fingerprint::{self, Candidate, Match};
use namzu_win_core::foreground::{
    BlockedBy, ForegroundGetRequest, ForegroundSetReply, ForegroundSetRequest, Lease,
    LeaseBeginReply, LeaseBeginRequest, LeaseEndReply, LeaseEndRequest, LeaseError, RaiseHow,
    Restore, RestoreFacts, Win, lease_file_has_token,
};
use namzu_win_core::input::{self, InputReply, InputRequest, InputVia};
use namzu_win_core::monitor::{MonitorPollRequest, MonitorStartReply, MonitorStartRequest};
use namzu_win_core::presence::{PresenceActReply, PresenceActRequest};
use namzu_win_core::protocol::{
    Action, DisplaysReply, ErrorCode, ExpandState, IdentityReply, IdentityRequest, Rect, ReplyBody,
    Request, ResolveRequest, SeqReply, Snapshot, SnapshotRequest, WindowsReply, WireError,
};
use namzu_win_core::refs::{self, RefTable};
use namzu_win_core::tree;
use namzu_win_core::window_id;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
use windows::Win32::UI::HiDpi::{
    AreDpiAwarenessContextsEqual, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    GetThreadDpiAwarenessContext, SetProcessDpiAwarenessContext,
};

use enumerate::{class_of, has_chromium, hwnd_from, hwnd_value, is_window, pid_of, process_start};
use foreground::OwnTicks;
use hooks::Hooks;
use hub::Hub;
use uia::{El, Subscription, Uia};

/// Windows watched at once; the least recently used is let go past this.
const MAX_WATCHED: usize = 32;
/// Windows whose last read is kept so a ref can be used again.
const MAX_READS: usize = 6;
const DEFAULT_TASK_MS: u64 = 8_000;

/// One control of a read: the live element a ref names, and what `act` needs
/// to decide before it calls the element.
struct Entry {
    element: El,
    identity: fingerprint::Identity,
    actions: Vec<Action>,
    enabled: bool,
    expand: Option<ExpandState>,
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
    /// The screen's worker: capture, input, foreground and the lease.
    io: SerialExecutor,
    /// The lease a burst of input holds, if any.
    lease: Mutex<Option<Lease>>,
    /// The raw-input and foreground watcher, while `monitor.start` has run.
    monitor: Mutex<Option<monitor::Monitor>>,
    /// The overlay's thread, started by the first `presence.act`.
    presence: Mutex<Option<presence::Presence>>,
    /// The helper's own sending, so its input is not taken for a person's.
    own: Mutex<Option<OwnTicks>>,
    captures: AtomicU64,
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
                io: SerialExecutor::new(uia::init_thread),
                lease: Mutex::new(None),
                monitor: Mutex::new(None),
                presence: Mutex::new(None),
                own: Mutex::new(None),
                captures: AtomicU64::new(0),
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
            .zip(walked.nodes.iter())
            .map(|((element, identity), node)| Entry {
                element,
                identity,
                actions: node.actions.clone(),
                enabled: node.enabled,
                expand: node.expand,
            })
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

/// The control an `act` names, with what is known about it.
struct Found {
    element: El,
    actions: Vec<Action>,
    enabled: bool,
    expand: Option<ExpandState>,
    /// Its place in the read that found it, and that read's revision.
    index: u32,
    revision: u64,
}

/// How long an input may take: a long text takes longer than a click.
fn input_timeout_ms(r: &InputRequest) -> u64 {
    match r {
        InputRequest::Type { text } => 10_000 + 20 * text.chars().count() as u64,
        _ => 8_000,
    }
}

fn refusal(r: Refusal) -> WireError {
    let code = match r {
        Refusal::BadArgs(_) => ErrorCode::BadRequest,
        Refusal::NoPattern(_) => ErrorCode::BackgroundUnavailable,
        Refusal::Disabled(_) => ErrorCode::Disabled,
    };
    err(code, r.message())
}

/// A failure of a pattern call, in the protocol's terms.
fn act_error(e: &windows::core::Error) -> WireError {
    const NOT_SUPPORTED: i32 = 0x8004_0204_u32 as i32;
    const NOT_ENABLED: i32 = 0x8004_0200_u32 as i32;
    const INVALID_OPERATION: i32 = 0x8013_1509_u32 as i32;
    match e.code().0 {
        NOT_SUPPORTED => err(
            ErrorCode::BackgroundUnavailable,
            "the control does not support this",
        ),
        NOT_ENABLED => err(ErrorCode::Disabled, "the control is turned off"),
        INVALID_OPERATION => err(
            ErrorCode::BackgroundUnavailable,
            "the control refused the call in its present state",
        ),
        _ => uia_error(e),
    }
}

fn ref_error(e: &refs::RefError) -> WireError {
    match e {
        refs::RefError::Malformed => err(ErrorCode::BadRequest, e.to_string()),
        refs::RefError::UnknownWindow => {
            err(ErrorCode::NotFound, "take a snapshot of the window first")
        }
        refs::RefError::Stale { .. } | refs::RefError::FromTheFuture { .. } => {
            err(ErrorCode::StaleSnapshot, e.to_string())
        }
        refs::RefError::OutOfRange { .. } => err(ErrorCode::NotFound, e.to_string()),
    }
}

/// The monitors as the DPI math knows them.
fn monitors() -> Vec<dpi::Monitor> {
    enumerate::displays()
        .into_iter()
        .map(|d| dpi::Monitor {
            id: d.id,
            bounds: d.bounds,
            dpi: (d.scale * 96.0).round() as u32,
        })
        .collect()
}

impl Inner {
    fn now(&self) -> f64 {
        self.hub.now_ms()
    }

    /// The control an `act` names, the facts about it, and the read that found it.
    fn control(&self, r: &ActRequest, window: HWND, pid: u32) -> Result<Found, WireError> {
        let target = r.target().map_err(|m| err(ErrorCode::BadRequest, m))?;
        let id = window_id::format(hwnd_value(window), pid);
        match target {
            ActTarget::Ref(reference) => {
                let ui = locked(&self.ui);
                let hit = ui.refs.get(&id, reference).map_err(|e| ref_error(&e))?;
                let (revision, index) = refs::parse_ref(reference)
                    .ok_or_else(|| err(ErrorCode::BadRequest, "not a ref"))?;
                let e = hit.entry;
                Ok(Found {
                    element: e.element.clone(),
                    actions: e.actions.clone(),
                    enabled: e.enabled,
                    expand: e.expand,
                    index,
                    revision,
                })
            }
            ActTarget::Fingerprint(fp) => {
                if !fingerprint::same_process_run(fp.process_start, process_start(pid)) {
                    return Err(err(
                        ErrorCode::NotFound,
                        "the program was started again since the control was read",
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
                match fingerprint::resolve(fp, &candidates) {
                    Match::Found { index, .. } => {
                        let i = index as usize;
                        let node = &walked.nodes[i];
                        Ok(Found {
                            element: walked.handles[i].clone(),
                            actions: node.actions.clone(),
                            enabled: node.enabled,
                            expand: node.expand,
                            index,
                            revision,
                        })
                    }
                    Match::NotFound => Err(err(
                        ErrorCode::NotFound,
                        "the control is no longer in the window",
                    )),
                    Match::Ambiguous { candidates } => Err(err(
                        ErrorCode::Ambiguous,
                        format!("{candidates} controls fit"),
                    )),
                }
            }
        }
    }

    fn act(&self, r: &ActRequest) -> Result<ReplyBody, WireError> {
        let (window, pid) = window_of(&r.window_id)?;
        let Found {
            element,
            actions,
            enabled,
            expand,
            index,
            revision,
        } = self.control(r, window, pid)?;
        let facts = Facts {
            actions: &actions,
            enabled,
            expand,
            read_only: r.action == namzu_win_core::act::ActKind::SetValue
                && act::read_only(&element),
        };
        let plan = namzu_win_core::act::plan(r, &facts).map_err(refusal)?;
        let before = act::read_state(&element, &actions);
        let started = std::time::Instant::now();
        act::perform(&element, &plan).map_err(|e| act_error(&e))?;
        let mut after = act::read_state(&element, &actions);
        let mut verified = namzu_win_core::act::verify(&plan, &before, &after);
        // The call can return before the application shows its own new state,
        // so a read-back that shows no effect is repeated for a short while
        // rather than reported as a failure. The decision is core's.
        let timeout = r.timeout_ms();
        // Time is counted from just before the call, so slow reads count
        // against the request's limit too and the reply is not sent late.
        while let Some(pause) = namzu_win_core::act::settle_pause(
            verified,
            u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            timeout,
        ) {
            std::thread::sleep(Duration::from_millis(pause));
            after = act::read_state(&element, &actions);
            verified = namzu_win_core::act::verify(&plan, &before, &after);
        }
        Ok(ReplyBody::Act(ActReply {
            done: true,
            via: ActVia::Pattern,
            verified,
            after: Some(after),
            index,
            revision,
        }))
    }

    fn mark_own(&self, ticks: Option<OwnTicks>) {
        *locked(&self.own) = ticks;
    }

    fn input(&self, r: &InputRequest) -> Result<ReplyBody, WireError> {
        // A held lease says whose screen this is: its window must still be in front.
        if let Some(lease) = locked(&self.lease).as_mut() {
            lease
                .admit(self.now(), foreground::front_win())
                .map_err(|e| match e {
                    LeaseError::Expired => err(
                        ErrorCode::LeaseExpired,
                        "the lease ran out; begin another before sending input",
                    ),
                    LeaseError::ForegroundLost => err(
                        ErrorCode::ForegroundLost,
                        "the window the lease is for is no longer in front; nothing was sent",
                    ),
                })?;
        }
        let desktop = input::Desktop::of(&monitors())
            .ok_or_else(|| err(ErrorCode::NotFound, "no display"))?;
        let steps = input::plan(r, &desktop).map_err(|m| err(ErrorCode::BadRequest, m))?;
        let in_lease = locked(&self.lease).is_some();
        let start = foreground::tick();
        if !in_lease {
            self.mark_own(Some(OwnTicks { start, end: None }));
        }
        let sent = sendinput::send(&steps);
        if !in_lease {
            // The guard of `own` must be gone before `mark_own` locks it again.
            self.mark_own(Some(OwnTicks {
                start,
                end: Some(foreground::tick()),
            }));
        }
        let delivered = sent?;
        Ok(ReplyBody::Input(InputReply {
            delivered,
            via: InputVia::SendInput,
            cursor: input::cursor_after(r).map(|_| foreground::cursor()),
        }))
    }

    fn capture(&self, r: &CaptureRequest) -> Result<ReplyBody, WireError> {
        let delivery = r.delivery().map_err(|m| err(ErrorCode::BadRequest, m))?;
        if let Delivery::File(dir) = delivery {
            if !std::path::Path::new(dir).is_dir() {
                return Err(err(
                    ErrorCode::BadRequest,
                    "`into` is not a directory that exists",
                ));
            }
        }
        // The first frame of a window comes at once or not at all.
        let wait = Duration::from_millis(r.timeout_ms().min(3_000));
        let cursor = r.cursor.unwrap_or(false);
        let shot = match &r.target {
            CaptureTarget::Window { window_id } => {
                let (window, _) = window_of(window_id)?;
                capture::window(window, cursor, wait)?
            }
            CaptureTarget::Display { id } => capture::display(id.as_deref(), cursor, wait)?,
            CaptureTarget::Region {
                x,
                y,
                width,
                height,
            } => capture::region(&Rect {
                x: *x,
                y: *y,
                width: *width,
                height: *height,
            })?,
        };
        let png = capture::encode_png(&shot)?;
        let sha256 = sha256_hex(&png);
        let (path, data_base64) = match delivery {
            Delivery::File(dir) => {
                let n = self.captures.fetch_add(1, Ordering::Relaxed) + 1;
                let file = std::path::Path::new(dir)
                    .join(format!("capture-{}-{n}.png", std::process::id()));
                std::fs::write(&file, &png).map_err(|e| {
                    err(
                        ErrorCode::Internal,
                        format!("could not write the picture: {e}"),
                    )
                })?;
                (Some(file.to_string_lossy().into_owned()), None)
            }
            Delivery::Inline => {
                if png.len() > INLINE_LIMIT {
                    return Err(err(
                        ErrorCode::BadRequest,
                        "the picture is too large to come back inline; give `into`",
                    ));
                }
                (None, Some(base64(&png)))
            }
        };
        Ok(ReplyBody::Capture(CaptureReply {
            path,
            data_base64,
            bytes: png.len() as u64,
            width: shot.width,
            height: shot.height,
            scale: shot.scale,
            via: shot.via,
            sha256,
            bounds: shot.bounds,
            display: shot.display,
        }))
    }

    fn foreground_get(&self, r: &ForegroundGetRequest) -> Result<ReplyBody, WireError> {
        let target_pid = match &r.window_id {
            Some(id) => Some(window_of(id)?.1),
            None => r.process_id,
        };
        let own = *locked(&self.own);
        Ok(ReplyBody::ForegroundGet(foreground::state(own, target_pid)))
    }

    fn foreground_set(&self, r: &ForegroundSetRequest) -> Result<ReplyBody, WireError> {
        let (window, pid) = window_of(&r.window_id)?;
        let how = foreground::raise(window);
        let raised = how != RaiseHow::Refused;
        let blocked_by = (!raised).then(|| {
            if proc::above(pid, proc::self_integrity()) {
                BlockedBy::Elevated
            } else {
                BlockedBy::Windows
            }
        });
        Ok(ReplyBody::ForegroundSet(ForegroundSetReply {
            raised,
            changed: raised && how != RaiseHow::Already,
            how,
            blocked_by,
        }))
    }

    fn lease_begin(&self, r: &LeaseBeginRequest) -> Result<ReplyBody, WireError> {
        let file = r
            .file()
            .map_err(|m| err(ErrorCode::BadRequest, m))?
            .map(|(p, t)| (p.to_owned(), t.to_owned()));
        let target = match &r.window_id {
            Some(id) => {
                let (window, pid) = window_of(id)?;
                Some((
                    window,
                    Win {
                        hwnd: hwnd_value(window),
                        pid,
                    },
                ))
            }
            None => None,
        };
        if r.raise.unwrap_or(false) && target.is_none() {
            return Err(err(ErrorCode::BadRequest, "raise needs a windowId"));
        }
        {
            let held = locked(&self.lease);
            match held.as_ref() {
                Some(l) if !l.expired(self.now()) => {
                    return Err(err(ErrorCode::LeaseBusy, "a lease is already held"));
                }
                _ => {}
            }
        }
        // One that ran out is ended first: its window and pointer go back.
        if locked(&self.lease).is_some() {
            let _ = self.end_lease(true, false, true);
        }
        let before = foreground::front_win();
        let cursor = foreground::cursor();
        let previous = *locked(&self.own);
        let pre = foreground::state(previous, target.as_ref().map(|(_, w)| w.pid));
        if r.idle_ms.is_some_and(|need| pre.user_idle_ms < need) {
            // A person is still using the machine: move nothing.
            return Ok(ReplyBody::LeaseBegin(LeaseBeginReply {
                state: pre,
                refused: true,
                raised: None,
                raise_how: None,
            }));
        }
        self.mark_own(Some(OwnTicks {
            start: foreground::tick(),
            end: None,
        }));
        let mut raised_win = None;
        let mut raise_result = None;
        if r.raise.unwrap_or(false) {
            if let Some((window, win)) = &target {
                let how = foreground::raise(*window);
                let in_front = how != RaiseHow::Refused;
                if in_front && foreground::front_win() != before {
                    raised_win = Some(*win);
                }
                raise_result = Some((in_front, how));
            }
        }
        // Taken after the raise: the unlock tap is this program's own input.
        let tick = u64::from(foreground::last_input_tick());
        *locked(&self.lease) = Some(Lease {
            target: target.as_ref().map(|(_, w)| *w),
            ttl_ms: r.ttl_ms(),
            last_ms: self.now(),
            before,
            raised: raised_win,
            cursor,
            tick,
            file,
            person_inputs: locked(&self.monitor).is_some().then(monitor::person_inputs),
        });
        let own = *locked(&self.own);
        Ok(ReplyBody::LeaseBegin(LeaseBeginReply {
            state: foreground::state(own, target.as_ref().map(|(_, w)| w.pid)),
            refused: false,
            raised: raise_result.map(|(r, _)| r),
            raise_how: raise_result.map(|(_, h)| h),
        }))
    }

    fn monitor_start(&self, r: &MonitorStartRequest) -> Result<ReplyBody, WireError> {
        let mut slot = locked(&self.monitor);
        if let Some(running) = slot.as_ref() {
            return Ok(ReplyBody::MonitorStart(MonitorStartReply {
                input: running.input,
                foreground: running.foreground,
            }));
        }
        let started = monitor::Monitor::start(r)
            .ok_or_else(|| err(ErrorCode::Internal, "the monitor thread did not start"))?;
        let reply = MonitorStartReply {
            input: started.input,
            foreground: started.foreground,
        };
        *slot = Some(started);
        Ok(ReplyBody::MonitorStart(reply))
    }

    fn monitor_stop(&self) {
        let taken = locked(&self.monitor).take();
        if let Some(m) = taken {
            m.stop();
        }
    }

    fn monitor_poll(&self, r: &MonitorPollRequest) -> Result<ReplyBody, WireError> {
        if locked(&self.monitor).is_none() {
            return Err(err(
                ErrorCode::BadRequest,
                "the monitor is not running; send monitor.start first",
            ));
        }
        Ok(ReplyBody::MonitorPoll(monitor::poll(r.since)))
    }

    fn presence_act(&self, r: &PresenceActRequest) -> Result<ReplyBody, WireError> {
        let (window, _) = window_of(&r.window_id)?;
        let mut slot = locked(&self.presence);
        if slot.is_none() {
            *slot = presence::Presence::start();
        }
        let overlay = slot
            .as_ref()
            .ok_or_else(|| err(ErrorCode::Internal, "the overlay thread did not start"))?;
        let (cursor_window, frame_window) = overlay
            .act(hwnd_value(window), r.kind, r.at)
            .ok_or_else(|| err(ErrorCode::Internal, "the overlay could not be shown"))?;
        Ok(ReplyBody::PresenceAct(PresenceActReply {
            cursor_window,
            frame_window,
        }))
    }

    fn presence_hide(&self) {
        if let Some(overlay) = locked(&self.presence).as_ref() {
            overlay.hide();
        }
    }

    fn lease_end(&self, r: &LeaseEndRequest) -> Result<ReplyBody, WireError> {
        self.end_lease(
            r.restore,
            r.keep_cursor.unwrap_or(false),
            r.release.unwrap_or(false),
        )
        .map(ReplyBody::LeaseEnd)
    }

    /// Ends the lease: puts the window and the pointer back when asked, and
    /// removes the lease file when its token is still the one given at begin.
    fn end_lease(
        &self,
        restore: bool,
        keep_cursor: bool,
        release: bool,
    ) -> Result<LeaseEndReply, WireError> {
        let lease = locked(&self.lease)
            .take()
            .ok_or_else(|| err(ErrorCode::BadRequest, "no lease is held"))?;
        let start = locked(&self.own).map_or_else(foreground::tick, |o| o.start);
        self.mark_own(Some(OwnTicks {
            start,
            end: Some(foreground::tick()),
        }));
        let input_moved = u64::from(foreground::last_input_tick()) != lease.tick;
        let current = foreground::front_win();
        let own_level = proc::self_integrity();
        let front_elevated = current.is_some_and(|c| proc::above(c.pid, own_level));
        let mut restored_foreground = false;
        let mut restored_cursor = false;
        let mut restore_note = None;
        if restore {
            let facts = RestoreFacts {
                before: lease.before,
                raised: lease.raised,
                target: lease.target,
                current,
                before_alive: lease
                    .before
                    .is_some_and(|b| foreground::exists(hwnd_from(b.hwnd))),
            };
            match namzu_win_core::foreground::restore_decision(&facts) {
                Restore::Put(w) => {
                    restored_foreground = foreground::raise(hwnd_from(w.hwnd)) != RaiseHow::Refused;
                    if !restored_foreground {
                        restore_note = Some(
                            "Windows would not give the front back to the previous window"
                                .to_owned(),
                        );
                    }
                }
                Restore::Skip(note) => restore_note = Some(note.to_owned()),
            }
            if !keep_cursor && foreground::cursor() != lease.cursor {
                restored_cursor = foreground::set_cursor(lease.cursor);
            }
        }
        let inputs_during = lease.person_inputs.and_then(|before| {
            locked(&self.monitor)
                .is_some()
                .then(|| monitor::person_inputs().saturating_sub(before))
        });
        let mut released = false;
        if release {
            if let Some((path, token)) = &lease.file {
                if let Ok(text) = std::fs::read_to_string(path) {
                    if lease_file_has_token(&text, token) {
                        released = std::fs::remove_file(path).is_ok();
                    }
                }
            }
        }
        Ok(LeaseEndReply {
            restored_foreground,
            restored_cursor,
            restore_note,
            input_moved,
            front_elevated,
            released,
            inputs_during,
        })
    }
}

/// Runs `work` on the accessibility worker and answers with its result; a task
/// that is overdue or cancelled is answered `timeout` or `cancelled` instead.
fn submit(
    inner: &Arc<Inner>,
    id: u64,
    timeout_ms: u64,
    responder: SharedResponder,
    work: impl FnOnce(&Inner) -> Result<ReplyBody, WireError> + Send + 'static,
) {
    submit_on(&inner.exec, inner, id, timeout_ms, responder, work);
}

/// The same on the screen's worker (capture, input, foreground, lease).
fn submit_io(
    inner: &Arc<Inner>,
    id: u64,
    timeout_ms: u64,
    responder: SharedResponder,
    work: impl FnOnce(&Inner) -> Result<ReplyBody, WireError> + Send + 'static,
) {
    submit_on(&inner.io, inner, id, timeout_ms, responder, work);
}

fn submit_on(
    exec: &SerialExecutor,
    inner: &Arc<Inner>,
    id: u64,
    timeout_ms: u64,
    responder: SharedResponder,
    work: impl FnOnce(&Inner) -> Result<ReplyBody, WireError> + Send + 'static,
) {
    let on_abandon = responder.clone();
    let worker_inner = Arc::clone(inner);
    exec.submit(Task {
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
            "act",
            "input",
            "capture",
            "foreground",
            "lease",
            "monitor",
            "rawinput",
            "presence",
            "uia",
            "hooks",
            "sendinput",
            "wgc",
            "printwindow",
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
            Request::Act(r) => {
                let timeout = r.timeout_ms();
                submit(
                    inner,
                    id,
                    timeout,
                    SharedResponder::new(responder),
                    move |i| i.act(&r),
                );
            }
            Request::Input(r) => {
                let timeout = input_timeout_ms(&r);
                submit_io(
                    inner,
                    id,
                    timeout,
                    SharedResponder::new(responder),
                    move |i| i.input(&r),
                );
            }
            Request::Capture(r) => {
                let timeout = r.timeout_ms();
                submit_io(
                    inner,
                    id,
                    timeout,
                    SharedResponder::new(responder),
                    move |i| i.capture(&r),
                );
            }
            Request::ForegroundGet(r) => {
                submit_io(
                    inner,
                    id,
                    DEFAULT_TASK_MS,
                    SharedResponder::new(responder),
                    move |i| i.foreground_get(&r),
                );
            }
            Request::ForegroundSet(r) => {
                submit_io(
                    inner,
                    id,
                    DEFAULT_TASK_MS,
                    SharedResponder::new(responder),
                    move |i| i.foreground_set(&r),
                );
            }
            Request::LeaseBegin(r) => {
                submit_io(
                    inner,
                    id,
                    DEFAULT_TASK_MS,
                    SharedResponder::new(responder),
                    move |i| i.lease_begin(&r),
                );
            }
            Request::LeaseEnd(r) => {
                submit_io(
                    inner,
                    id,
                    DEFAULT_TASK_MS,
                    SharedResponder::new(responder),
                    move |i| i.lease_end(&r),
                );
            }
            Request::MonitorStart(r) => {
                let reply = inner.monitor_start(&r);
                responder.send(reply);
            }
            Request::MonitorStop => {
                inner.monitor_stop();
                responder.ok(ReplyBody::Ack);
            }
            Request::MonitorPoll(r) => {
                let reply = inner.monitor_poll(&r);
                responder.send(reply);
            }
            Request::PresenceAct(r) => {
                submit_io(
                    inner,
                    id,
                    DEFAULT_TASK_MS,
                    SharedResponder::new(responder),
                    move |i| i.presence_act(&r),
                );
            }
            Request::PresenceHide => {
                submit_io(
                    inner,
                    id,
                    DEFAULT_TASK_MS,
                    SharedResponder::new(responder),
                    move |i| {
                        i.presence_hide();
                        Ok(ReplyBody::Ack)
                    },
                );
            }
            // Answered by the loop before they get here.
            Request::Hello(_) | Request::Cancel(_) | Request::Quit => {
                responder.fail(ErrorCode::Internal, "this op is answered by the loop");
            }
        }
    }

    fn shutdown(&self) {
        // A lease still held when the caller goes away is ended the way a
        // burst ends: the window and pointer put back, the lease file removed,
        // so a crash does not leave the screen locked.
        let held = locked(&self.inner.lease).is_some();
        if held {
            let _ = self.inner.end_lease(true, false, true);
        }
        self.inner.monitor_stop();
        let overlay = locked(&self.inner.presence).take();
        if let Some(overlay) = overlay {
            overlay.stop();
        }
    }

    fn cancel(&self, target: u64) {
        self.inner.exec.cancel(target);
        self.inner.io.cancel(target);
        self.inner
            .hub
            .end_wait(target, err(ErrorCode::Cancelled, "cancelled"));
    }
}
