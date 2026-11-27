//! Watching the controls a person uses, with no input hook of any kind.
//!
//! One thread, started by `watch.start` and ended by `watch.stop`, owns every
//! subscription. It registers read-only UI Automation event handlers on the
//! desktop root (invoke, focus change, selection, menu opened and closed,
//! window opened and closed, and the value property of controls) and a
//! `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` for the program in front, then
//! runs a message loop (the foreground hook is delivered to it) until stopped.
//! On the way out every handler is removed.
//!
//! What this file never does: register Raw Input, call `SetWindowsHookEx`,
//! poll key state, or read a key, a character typed, a mouse button or a
//! pointer position. A handler reads the control it was told about (role,
//! name, whether it is a password field, and the text of an ordinary edit
//! control) and hands it to the portable [`WatchQueue`], which applies the
//! secure rule, the caps and the coalescing. A password field's text is not
//! even requested here.
//!
//! The handlers run on threads UI Automation owns, so they only read and push
//! into the queue behind a mutex; nothing in them waits on this helper's other
//! workers.

use namzu_win_core::tree::control_type_name;
use namzu_win_core::watch::{
    Phase, RawWatch, WatchConfig, WatchKind, WatchPollReply, WatchQueue, WatchStartRequest,
    is_edit_role,
};
use namzu_win_core::window_id;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Instant;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, HWINEVENTHOOK, IUIAutomation, IUIAutomationCacheRequest, IUIAutomationElement,
    IUIAutomationEventHandler, IUIAutomationEventHandler_Impl,
    IUIAutomationFocusChangedEventHandler, IUIAutomationFocusChangedEventHandler_Impl,
    IUIAutomationPropertyChangedEventHandler, IUIAutomationPropertyChangedEventHandler_Impl,
    IUIAutomationValuePattern, SetWinEventHook, TreeScope_Subtree, UIA_EVENT_ID,
    UIA_Invoke_InvokedEventId, UIA_MenuClosedEventId, UIA_MenuOpenedEventId, UIA_PROPERTY_ID,
    UIA_SelectionItem_ElementSelectedEventId, UIA_ValuePatternId, UIA_ValueValuePropertyId,
    UIA_Window_WindowClosedEventId, UIA_Window_WindowOpenedEventId, UnhookWinEvent,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetForegroundWindow, GetMessageW, MSG, PM_NOREMOVE, PeekMessageW,
    PostThreadMessageW, TranslateMessage, WM_QUIT,
};
use windows::core::{Ref, implement};

use super::{enumerate, uia};

const EVENT_SYSTEM_FOREGROUND: u32 = 3;
const WINEVENT_OUTOFCONTEXT: u32 = 0;

struct State {
    queue: WatchQueue,
    epoch: Instant,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
/// The handlers may still be called for a moment after stop; they check this first.
static ACTIVE: AtomicBool = AtomicBool::new(false);

fn state() -> MutexGuard<'static, Option<State>> {
    match STATE.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

/// Hands one reading to the queue, stamped with the monotonic clock.
fn push(mut raw: RawWatch) {
    if !ACTIVE.load(Ordering::SeqCst) {
        return;
    }
    if let Some(s) = state().as_mut() {
        raw.t_ms = s.epoch.elapsed().as_millis() as u64;
        s.queue.record(raw);
    }
}

/// The wanted kinds as the queue was configured with, to skip work for the others.
fn wants(kind: WatchKind) -> bool {
    state()
        .as_ref()
        .is_some_and(|s| s.queue.config().wants(kind))
}

/// What the helper reads of a control: only its role, name, password flag,
/// program and, for an ordinary edit control that is not a password field, its text.
fn read(element: &IUIAutomationElement, kind: WatchKind, phase: Option<Phase>) -> RawWatch {
    // SAFETY: plain property reads on an element UI Automation handed over.
    unsafe {
        let role = element
            .CurrentControlType()
            .map(|t| control_type_name(t.0).to_owned())
            .ok();
        let name = element.CurrentName().map(|n| n.to_string()).ok();
        let secure = element.CurrentIsPassword().is_ok_and(|b| b.as_bool());
        let pid = element.CurrentProcessId().map_or(0, |p| p as u32);
        let own = element
            .CurrentNativeWindowHandle()
            .ok()
            .filter(|h| !h.0.is_null());
        let automation_id = element
            .CurrentAutomationId()
            .map(|n| n.to_string())
            .unwrap_or_default();
        // The window the control is in: its own handle's top-level window, or
        // (for a control with no handle of its own, as in a browser) the one
        // in front, which is where a person's action lands.
        let top = own
            .map(|h| enumerate::root(h).0)
            .or_else(|| {
                let fg = GetForegroundWindow();
                (!fg.0.is_null()).then(|| enumerate::root(fg).0)
            })
            .filter(|h| !h.0.is_null());
        let (window, window_id, process) = match top {
            Some(h) => {
                let wpid = enumerate::pid_of(h);
                (
                    Some(enumerate::title_of(h)),
                    Some(window_id::format(enumerate::hwnd_value(h), wpid)),
                    Some(enumerate::process_name(if pid != 0 { pid } else { wpid })),
                )
            }
            None => (None, None, (pid != 0).then(|| enumerate::process_name(pid))),
        };
        // The text of an ordinary edit control, never of a password field: the
        // value pattern is not even asked when the flag is set.
        let value =
            (kind == WatchKind::Value && !secure && role.as_deref().is_some_and(is_edit_role))
                .then(|| {
                    element
                        .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                        .and_then(|p| p.CurrentValue())
                        .map(|v| v.to_string())
                        .ok()
                })
                .flatten();
        let key = format!(
            "{pid}/{}/{automation_id}/{}/{}",
            own.map_or(0, enumerate::hwnd_value),
            role.as_deref().unwrap_or(""),
            name.as_deref().unwrap_or("")
        );
        RawWatch {
            kind: Some(kind),
            t_ms: 0,
            role,
            name,
            value,
            secure,
            phase,
            window,
            process,
            window_id,
            key: Some(key),
        }
    }
}

#[implement(IUIAutomationEventHandler)]
struct AutomationHandler {
    _unit: (),
}

impl IUIAutomationEventHandler_Impl for AutomationHandler_Impl {
    fn HandleAutomationEvent(
        &self,
        sender: Ref<'_, IUIAutomationElement>,
        eventid: UIA_EVENT_ID,
    ) -> windows::core::Result<()> {
        let (kind, phase) = if eventid == UIA_Invoke_InvokedEventId {
            (WatchKind::Invoke, None)
        } else if eventid == UIA_SelectionItem_ElementSelectedEventId {
            (WatchKind::Selection, None)
        } else if eventid == UIA_MenuOpenedEventId {
            (WatchKind::Menu, Some(Phase::Open))
        } else if eventid == UIA_MenuClosedEventId {
            (WatchKind::Menu, Some(Phase::Close))
        } else if eventid == UIA_Window_WindowOpenedEventId {
            (WatchKind::Window, Some(Phase::Open))
        } else if eventid == UIA_Window_WindowClosedEventId {
            (WatchKind::Window, Some(Phase::Close))
        } else {
            return Ok(());
        };
        if !wants(kind) {
            return Ok(());
        }
        if let Some(element) = sender.as_ref() {
            push(read(element, kind, phase));
        }
        Ok(())
    }
}

#[implement(IUIAutomationFocusChangedEventHandler)]
struct FocusHandler {
    _unit: (),
}

impl IUIAutomationFocusChangedEventHandler_Impl for FocusHandler_Impl {
    fn HandleFocusChangedEvent(
        &self,
        sender: Ref<'_, IUIAutomationElement>,
    ) -> windows::core::Result<()> {
        if let Some(element) = sender.as_ref() {
            push(read(element, WatchKind::Focus, None));
        }
        Ok(())
    }
}

#[implement(IUIAutomationPropertyChangedEventHandler)]
struct ValueHandler {
    _unit: (),
}

impl IUIAutomationPropertyChangedEventHandler_Impl for ValueHandler_Impl {
    fn HandlePropertyChangedEvent(
        &self,
        sender: Ref<'_, IUIAutomationElement>,
        _propertyid: UIA_PROPERTY_ID,
        _newvalue: &windows::Win32::System::Variant::VARIANT,
    ) -> windows::core::Result<()> {
        if let Some(element) = sender.as_ref() {
            push(read(element, WatchKind::Value, None));
        }
        Ok(())
    }
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
    if event != EVENT_SYSTEM_FOREGROUND || hwnd.0.is_null() || !wants(WatchKind::App) {
        return;
    }
    let (root, _) = enumerate::root(hwnd);
    let pid = enumerate::pid_of(root);
    push(RawWatch {
        kind: Some(WatchKind::App),
        window: Some(enumerate::title_of(root)),
        process: Some(enumerate::process_name(pid)),
        window_id: Some(window_id::format(enumerate::hwnd_value(root), pid)),
        ..RawWatch::default()
    });
}

/// The running watch: its thread and what came up.
pub struct Watch {
    thread_id: u32,
    join: Option<JoinHandle<()>>,
    pub controls: bool,
    pub foreground: bool,
    pub kinds: Vec<WatchKind>,
}

/// The queued events since the last poll.
pub fn poll() -> WatchPollReply {
    match state().as_mut() {
        Some(s) => s.queue.poll(),
        None => WatchPollReply {
            events: Vec::new(),
            dropped: 0,
        },
    }
}

impl Watch {
    /// Starts the thread. `None` when it did not come up at all.
    pub fn start(request: &WatchStartRequest) -> Option<Watch> {
        let config = request.config();
        let kinds = config.kinds.clone();
        *state() = Some(State {
            queue: WatchQueue::new(config.clone()),
            epoch: Instant::now(),
        });
        ACTIVE.store(true, Ordering::SeqCst);
        let (ready_tx, ready_rx) = channel::<(u32, bool, bool)>();
        let spawned = std::thread::Builder::new()
            .name("namzu-win-watch".to_owned())
            .spawn(move || run(config, ready_tx));
        let (thread_id, controls, foreground) = match spawned.ok().map(|j| (j, ready_rx.recv())) {
            Some((join, Ok(ready))) => {
                return Some(Watch {
                    thread_id: ready.0,
                    join: Some(join),
                    controls: ready.1,
                    foreground: ready.2,
                    kinds,
                });
            }
            _ => (0, false, false),
        };
        let _ = (thread_id, controls, foreground);
        ACTIVE.store(false, Ordering::SeqCst);
        *state() = None;
        None
    }

    /// Removes every subscription, waits for the thread and clears the queue.
    pub fn stop(mut self) {
        ACTIVE.store(false, Ordering::SeqCst);
        // SAFETY: a plain post to a thread of this process.
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
        *state() = None;
    }
}

fn run(config: WatchConfig, ready: Sender<(u32, bool, bool)>) {
    uia::init_thread();
    // SAFETY: the calls below follow their documented contracts; every handler
    // registered here is removed here before the thread ends.
    unsafe {
        let mut msg = MSG::default();
        // Touching the queue creates it, so a message posted early is kept.
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        let mut controls = false;
        let automation: Option<IUIAutomation> =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok();
        // The handlers are held until the end: UI Automation holds its own
        // reference, but the removal below names these.
        let mut held: Vec<Box<dyn std::any::Any>> = Vec::new();
        if let Some(automation) = automation.as_ref() {
            if let Ok(root) = automation.GetRootElement() {
                let none = None::<&IUIAutomationCacheRequest>;
                let events: IUIAutomationEventHandler = AutomationHandler { _unit: () }.into();
                let mut ids: Vec<UIA_EVENT_ID> = Vec::new();
                for (kind, wanted) in [
                    (WatchKind::Invoke, vec![UIA_Invoke_InvokedEventId]),
                    (
                        WatchKind::Selection,
                        vec![UIA_SelectionItem_ElementSelectedEventId],
                    ),
                    (
                        WatchKind::Menu,
                        vec![UIA_MenuOpenedEventId, UIA_MenuClosedEventId],
                    ),
                    (
                        WatchKind::Window,
                        vec![
                            UIA_Window_WindowOpenedEventId,
                            UIA_Window_WindowClosedEventId,
                        ],
                    ),
                ] {
                    if config.wants(kind) {
                        ids.extend(wanted);
                    }
                }
                for id in ids {
                    controls |= automation
                        .AddAutomationEventHandler(id, &root, TreeScope_Subtree, none, &events)
                        .is_ok();
                }
                held.push(Box::new(events));
                if config.wants(WatchKind::Focus) {
                    let focus: IUIAutomationFocusChangedEventHandler =
                        FocusHandler { _unit: () }.into();
                    controls |= automation.AddFocusChangedEventHandler(none, &focus).is_ok();
                    held.push(Box::new(focus));
                }
                if config.wants(WatchKind::Value) {
                    let value: IUIAutomationPropertyChangedEventHandler =
                        ValueHandler { _unit: () }.into();
                    controls |= automation
                        .AddPropertyChangedEventHandlerNativeArray(
                            &root,
                            TreeScope_Subtree,
                            none,
                            &value,
                            &[UIA_ValueValuePropertyId],
                        )
                        .is_ok();
                    held.push(Box::new(value));
                }
            }
        }
        let mut hook = HWINEVENTHOOK::default();
        if config.wants(WatchKind::App) {
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
        let _ = ready.send((GetCurrentThreadId(), controls, !hook.0.is_null()));
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if !hook.0.is_null() {
            let _ = UnhookWinEvent(hook);
        }
        if let Some(automation) = automation.as_ref() {
            let _ = automation.RemoveAllEventHandlers();
        }
        drop(held);
    }
}
