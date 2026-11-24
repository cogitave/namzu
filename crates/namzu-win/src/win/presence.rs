//! The presence overlay's two windows: the agent's cursor and a frame round
//! the operated window.
//!
//! Both are layered, click-through (`WS_EX_TRANSPARENT`), never activated
//! (`WS_EX_NOACTIVATE`) and kept out of the taskbar and Alt-Tab
//! (`WS_EX_TOOLWINDOW`), and placed directly above the operated window in the
//! z-order, never above the others. They are NOT excluded from screen capture:
//! no `SetWindowDisplayAffinity` call is made anywhere, so a screenshot of the
//! desktop shows what a person sees, overlay included.
//!
//! One thread owns the windows and pumps messages, because a window belongs
//! to the thread that made it. Commands arrive on a queue and wake it with a
//! thread message; a 16 ms timer runs only while something is shown. What is
//! drawn comes from [`namzu_win_core::presence`]; this file only puts bitmaps
//! on windows.

use namzu_win_core::dpi::Point;
use namzu_win_core::presence::{
    Animator, Bitmap, PresenceKind, RippleFrame, constant_alpha, cursor_window_size, render_cursor,
    render_frame,
};
use std::collections::VecDeque;
use std::ffi::c_void;
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    AC_SRC_ALPHA, AC_SRC_OVER, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION,
    CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, HBITMAP,
    HDC, ReleaseDC, SelectObject,
};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GW_HWNDPREV, GetMessageW,
    GetWindow, HWND_TOP, IsIconic, IsWindow, KillTimer, MSG, PM_NOREMOVE, PeekMessageW,
    PostThreadMessageW, RegisterClassExW, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SetTimer, SetWindowPos, ShowWindow, TranslateMessage, ULW_ALPHA, UnregisterClassW,
    UpdateLayeredWindow, WM_APP, WM_QUIT, WM_TIMER, WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
};
use windows::core::w;

use super::enumerate;

const WM_COMMANDS: u32 = WM_APP + 1;
const TICK_MS: u32 = 16;

enum Cmd {
    Act {
        window: u64,
        kind: PresenceKind,
        at: Option<Point>,
        done: Sender<Option<(u64, u64)>>,
    },
    Hide {
        done: Sender<()>,
    },
}

pub struct Presence {
    thread_id: u32,
    queue: Arc<Mutex<VecDeque<Cmd>>>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl Presence {
    pub fn start() -> Option<Presence> {
        let queue: Arc<Mutex<VecDeque<Cmd>>> = Arc::new(Mutex::new(VecDeque::new()));
        let (ready_tx, ready_rx) = channel::<u32>();
        let worker = Arc::clone(&queue);
        let join = std::thread::Builder::new()
            .name("namzu-win-presence".to_owned())
            .spawn(move || run(worker, ready_tx))
            .ok()?;
        let thread_id = ready_rx.recv().ok()?;
        Some(Presence {
            thread_id,
            queue,
            join: Mutex::new(Some(join)),
        })
    }

    fn call<T>(&self, make: impl FnOnce(Sender<T>) -> Cmd) -> Option<T> {
        let (tx, rx) = channel();
        self.queue.lock().ok()?.push_back(make(tx));
        // SAFETY: a plain post to a thread of this process.
        unsafe {
            PostThreadMessageW(self.thread_id, WM_COMMANDS, WPARAM(0), LPARAM(0)).ok()?;
        }
        rx.recv().ok()
    }

    /// Shows or refreshes the overlay for one action. The two windows' handles.
    pub fn act(&self, window: u64, kind: PresenceKind, at: Option<Point>) -> Option<(u64, u64)> {
        self.call(|done| Cmd::Act {
            window,
            kind,
            at,
            done,
        })
        .flatten()
    }

    pub fn hide(&self) {
        let _ = self.call(|done| Cmd::Hide { done });
    }

    /// Ends the thread; its windows go with it.
    pub fn stop(&self) {
        // SAFETY: a plain post to a thread of this process.
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        let join = self.join.lock().ok().and_then(|mut j| j.take());
        if let Some(join) = join {
            let _ = join.join();
        }
    }
}

unsafe extern "system" fn wnd_proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    // SAFETY: the arguments are the ones the system gave this procedure.
    unsafe { DefWindowProcW(h, m, w, l) }
}

/// A layered window and the bitmap it shows.
struct Layer {
    hwnd: HWND,
    mem: HDC,
    bitmap: HBITMAP,
    bits: *mut c_void,
    width: u32,
    height: u32,
    shown: bool,
}

impl Layer {
    fn new() -> Option<Layer> {
        // SAFETY: a plain window creation; the class is registered by `run`.
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                w!("NamzuWinPresence"),
                w!(""),
                WS_POPUP,
                0,
                0,
                1,
                1,
                None,
                None,
                None,
                None,
            )
        }
        .ok()?;
        Some(Layer {
            hwnd,
            mem: HDC::default(),
            bitmap: HBITMAP::default(),
            bits: std::ptr::null_mut(),
            width: 0,
            height: 0,
            shown: false,
        })
    }

    fn free_bitmap(&mut self) {
        // SAFETY: both handles were made by `fit` and are released once.
        unsafe {
            if !self.mem.is_invalid() {
                let _ = DeleteDC(self.mem);
            }
            if !self.bitmap.is_invalid() {
                let _ = DeleteObject(self.bitmap.into());
            }
        }
        self.mem = HDC::default();
        self.bitmap = HBITMAP::default();
        self.bits = std::ptr::null_mut();
    }

    /// Makes the backing bitmap `width` by `height`.
    fn fit(&mut self, width: u32, height: u32) -> bool {
        if self.width == width && self.height == height && !self.bits.is_null() {
            return true;
        }
        self.free_bitmap();
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        // SAFETY: `info` describes a top-down 32-bit bitmap; the DC is released after use.
        unsafe {
            let screen = GetDC(None);
            let mem = CreateCompatibleDC(Some(screen));
            let mut bits: *mut c_void = std::ptr::null_mut();
            let bitmap = CreateDIBSection(Some(screen), &info, DIB_RGB_COLORS, &mut bits, None, 0);
            ReleaseDC(None, screen);
            match bitmap {
                Ok(bitmap) if !bits.is_null() && !mem.is_invalid() => {
                    SelectObject(mem, bitmap.into());
                    self.mem = mem;
                    self.bitmap = bitmap;
                    self.bits = bits;
                    self.width = width;
                    self.height = height;
                    true
                }
                _ => {
                    if !mem.is_invalid() {
                        let _ = DeleteDC(mem);
                    }
                    self.width = 0;
                    self.height = 0;
                    false
                }
            }
        }
    }

    fn paint(&mut self, bitmap: &Bitmap) -> bool {
        if !self.fit(bitmap.width, bitmap.height) {
            return false;
        }
        // SAFETY: `bits` holds `width * height * 4` bytes, which is what is copied.
        unsafe {
            std::ptr::copy_nonoverlapping(
                bitmap.bgra.as_ptr(),
                self.bits as *mut u8,
                bitmap.bgra.len(),
            );
        }
        true
    }

    /// Puts the bitmap on screen at `at` with constant alpha `alpha`.
    fn present(&mut self, at: (i32, i32), alpha: u8) {
        if self.bits.is_null() {
            return;
        }
        let dst = POINT { x: at.0, y: at.1 };
        let size = SIZE {
            cx: self.width as i32,
            cy: self.height as i32,
        };
        let src = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: alpha,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        // SAFETY: every pointer is to a local that lives through the call.
        unsafe {
            let _ = UpdateLayeredWindow(
                self.hwnd,
                None,
                Some(&dst),
                Some(&size),
                Some(self.mem),
                Some(&src),
                COLORREF(0),
                Some(&blend),
                ULW_ALPHA,
            );
            if !self.shown {
                let _ = ShowWindow(self.hwnd, SW_SHOWNOACTIVATE);
                self.shown = true;
            }
        }
    }

    fn hide(&mut self) {
        if self.shown {
            // SAFETY: a plain call on a window of this thread.
            unsafe {
                let _ = ShowWindow(self.hwnd, SW_HIDE);
            }
            self.shown = false;
        }
    }

    fn destroy(&mut self) {
        self.free_bitmap();
        // SAFETY: the window belongs to this thread.
        unsafe {
            let _ = DestroyWindow(self.hwnd);
        }
    }
}

/// The key of what the cursor window shows, so a tick that changes nothing draws nothing.
#[derive(PartialEq, Clone, Copy)]
struct CursorKey {
    scale: u32,
    size: u32,
    ripple: Option<(u32, u32, u32)>,
}

struct State {
    cursor: Layer,
    frame: Layer,
    anim: Animator,
    target: HWND,
    scale: f64,
    frame_key: Option<(u32, u32, u32)>,
    cursor_key: Option<CursorKey>,
    ticks: u32,
    timer: usize,
    started: Instant,
}

fn q(v: f64) -> u32 {
    (v * 1000.0).round().max(0.0) as u32
}

impl State {
    fn now(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    /// Both windows directly above the operated one, the cursor above the frame.
    fn stack(&self) {
        // SAFETY: plain calls on windows of this process.
        unsafe {
            let mut above = GetWindow(self.target, GW_HWNDPREV).ok();
            while let Some(w) = above {
                if w == self.cursor.hwnd || w == self.frame.hwnd {
                    above = GetWindow(w, GW_HWNDPREV).ok();
                } else {
                    break;
                }
            }
            let after = above.filter(|w| !w.0.is_null()).unwrap_or(HWND_TOP);
            let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
            let _ = SetWindowPos(self.frame.hwnd, Some(after), 0, 0, 0, 0, flags);
            let _ = SetWindowPos(self.cursor.hwnd, Some(self.frame.hwnd), 0, 0, 0, 0, flags);
        }
    }

    fn hide_all(&mut self) {
        self.cursor.hide();
        self.frame.hide();
        self.cursor_key = None;
        self.frame_key = None;
    }

    fn tick(&mut self) {
        let now = self.now();
        let alive =
            unsafe { IsWindow(Some(self.target)).as_bool() && !IsIconic(self.target).as_bool() };
        let scene = if alive { self.anim.scene(now) } else { None };
        let Some(scene) = scene else {
            self.hide_all();
            if !self.anim.shown() || !alive {
                self.stop_timer();
            }
            return;
        };
        self.ticks = self.ticks.wrapping_add(1);
        let rect = enumerate::frame_rect(self.target, false);
        if rect.width > 0 && rect.height > 0 {
            let key = (rect.width as u32, rect.height as u32, q(self.scale));
            if self.frame_key != Some(key) {
                let bitmap = render_frame(key.0, key.1, self.scale);
                if self.frame.paint(&bitmap) {
                    self.frame_key = Some(key);
                }
            }
            self.frame
                .present((rect.x, rect.y), constant_alpha(scene.frame_alpha));
        }
        if let Some(c) = scene.cursor {
            let ripple = c.ripple;
            let key = CursorKey {
                scale: q(self.scale),
                size: q(c.size),
                ripple: ripple.map(|r: RippleFrame| (q(r.radius), q(r.alpha), q(r.stroke))),
            };
            if self.cursor_key != Some(key) {
                let bitmap = render_cursor(self.scale, c.size, ripple);
                if self.cursor.paint(&bitmap) {
                    self.cursor_key = Some(key);
                }
            }
            let half = (cursor_window_size(self.scale) / 2) as f64;
            self.cursor.present(
                (
                    (c.tip.0 - half).round() as i32,
                    (c.tip.1 - half).round() as i32,
                ),
                constant_alpha(c.alpha),
            );
        } else {
            self.cursor.hide();
        }
        if self.ticks % 10 == 1 {
            self.stack();
        }
    }

    fn start_timer(&mut self) {
        if self.timer == 0 {
            // SAFETY: a thread timer with no callback; WM_TIMER comes to this thread's loop.
            self.timer = unsafe { SetTimer(None, 0, TICK_MS, None) };
        }
    }

    fn stop_timer(&mut self) {
        if self.timer != 0 {
            // SAFETY: the timer was made by `start_timer` on this thread.
            unsafe {
                let _ = KillTimer(None, self.timer);
            }
            self.timer = 0;
        }
    }

    fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Act {
                window,
                kind,
                at,
                done,
            } => {
                let window = enumerate::hwnd_from(window);
                // SAFETY: a plain query.
                if unsafe { !IsWindow(Some(window)).as_bool() } {
                    let _ = done.send(None);
                    return;
                }
                if self.target != window {
                    // A new window starts over: the cursor appears there, it does not fly in from the last one.
                    self.anim.hide();
                    self.frame_key = None;
                }
                self.target = window;
                // SAFETY: a plain query.
                let dpi = unsafe { GetDpiForWindow(window) };
                self.scale = if dpi == 0 { 1.0 } else { f64::from(dpi) / 96.0 };
                let now = self.now();
                self.anim.act(
                    now,
                    kind,
                    at.map(|p| (f64::from(p.x), f64::from(p.y))),
                    self.scale,
                );
                self.start_timer();
                self.tick();
                self.stack();
                let _ = done.send(Some((
                    enumerate::hwnd_value(self.cursor.hwnd),
                    enumerate::hwnd_value(self.frame.hwnd),
                )));
            }
            Cmd::Hide { done } => {
                self.anim.hide();
                self.hide_all();
                self.stop_timer();
                let _ = done.send(());
            }
        }
    }
}

fn run(queue: Arc<Mutex<VecDeque<Cmd>>>, ready: Sender<u32>) {
    // SAFETY: the calls follow their documented contracts; every window made
    // here is destroyed here before the thread ends.
    unsafe {
        let mut msg = MSG::default();
        let _ = PeekMessageW(&mut msg, None, 0, 0, PM_NOREMOVE);
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(wnd_proc),
            lpszClassName: w!("NamzuWinPresence"),
            ..Default::default()
        };
        let _ = RegisterClassExW(&class);
        let made = Layer::new().zip(Layer::new());
        let _ = ready.send(GetCurrentThreadId());
        let Some((cursor, frame)) = made else {
            // No windows: every command is answered with nothing until the thread is stopped.
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                if msg.message == WM_COMMANDS {
                    drain_unanswered(&queue);
                }
            }
            return;
        };
        let mut state = State {
            cursor,
            frame,
            anim: Animator::new(),
            target: HWND::default(),
            scale: 1.0,
            frame_key: None,
            cursor_key: None,
            ticks: 0,
            timer: 0,
            started: Instant::now(),
        };
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            if msg.message == WM_COMMANDS {
                loop {
                    let next = queue.lock().ok().and_then(|mut q| q.pop_front());
                    let Some(cmd) = next else { break };
                    state.handle(cmd);
                }
            } else if msg.message == WM_TIMER && msg.hwnd.0.is_null() {
                state.tick();
            } else {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        state.stop_timer();
        state.cursor.destroy();
        state.frame.destroy();
        let _ = UnregisterClassW(w!("NamzuWinPresence"), None);
    }
}

fn drain_unanswered(queue: &Arc<Mutex<VecDeque<Cmd>>>) {
    while let Some(cmd) = queue.lock().ok().and_then(|mut q| q.pop_front()) {
        match cmd {
            Cmd::Act { done, .. } => {
                let _ = done.send(None);
            }
            Cmd::Hide { done } => {
                let _ = done.send(());
            }
        }
    }
}
