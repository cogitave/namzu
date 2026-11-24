//! Where changes are collected and waits are settled.
//!
//! Event sources (UI Automation handlers, system window hooks) call
//! [`Hub::push`] and return at once; nothing in a callback calls back into
//! accessibility. One scheduler thread owns the waits: it wakes when an event
//! arrives or when the earliest wait is due, never on a timer of its own.

use crate::backend::SharedResponder;
use namzu_win_core::events::{EventLog, Kind, Origin, Outcome, Poll, WaitSpec, Waiter};
use namzu_win_core::protocol::{ReplyBody, WaitResult, WireError};
use namzu_win_core::window_id;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use super::enumerate;

struct Pending {
    id: u64,
    waiter: Waiter,
    responder: SharedResponder,
}

#[derive(Default)]
struct State {
    log: EventLog,
    waiters: Vec<Pending>,
    dirty: bool,
}

pub struct Hub {
    state: Mutex<State>,
    wake: Condvar,
    epoch: Instant,
}

fn locked(hub: &Hub) -> MutexGuard<'_, State> {
    match hub.state.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

impl Hub {
    pub fn new() -> Arc<Hub> {
        let hub = Arc::new(Hub {
            state: Mutex::new(State::default()),
            wake: Condvar::new(),
            epoch: Instant::now(),
        });
        let scheduler = Arc::clone(&hub);
        std::thread::Builder::new()
            .name("namzu-win-waits".to_owned())
            .spawn(move || scheduler.run())
            .expect("start the wait scheduler thread");
        hub
    }

    /// Milliseconds since the hub started: the clock events and waits share.
    pub fn now_ms(&self) -> f64 {
        self.epoch.elapsed().as_secs_f64() * 1000.0
    }

    /// Records one event. Safe to call from any callback: takes a lock and returns.
    pub fn push(&self, origin: Origin, kind: Kind, hwnd: u64, root: u64, pid: u32, top: bool) {
        let ms = self.now_ms();
        let mut st = locked(self);
        st.log.push(ms, origin, kind, hwnd, root, pid, top);
        st.dirty = true;
        self.wake.notify_all();
    }

    /// The marker a later wait counts from.
    pub fn seq(&self) -> u64 {
        locked(self).log.seq()
    }

    /// Starts a wait; its answer goes to `responder` when it settles or runs out.
    pub fn add_wait(&self, id: u64, spec: &WaitSpec, responder: SharedResponder) {
        let now = self.now_ms();
        let mut st = locked(self);
        let waiter = Waiter::new(&st.log, now, spec);
        st.waiters.push(Pending {
            id,
            waiter,
            responder,
        });
        st.dirty = true;
        self.wake.notify_all();
    }

    /// Ends wait `id` with `error`; true if it was still waiting.
    pub fn end_wait(&self, id: u64, error: WireError) -> bool {
        let pending = {
            let mut st = locked(self);
            st.waiters
                .iter()
                .position(|p| p.id == id)
                .map(|pos| st.waiters.remove(pos))
        };
        match pending {
            Some(p) => {
                p.responder.send(Err(error));
                true
            }
            None => false,
        }
    }

    fn run(&self) {
        let mut st = locked(self);
        loop {
            let now = self.now_ms();
            let mut done: Vec<(SharedResponder, Outcome)> = Vec::new();
            let mut next_due: Option<f64> = None;
            let State { log, waiters, .. } = &mut *st;
            let mut i = waiters.len();
            while i > 0 {
                i -= 1;
                match waiters[i].waiter.poll(log, now) {
                    Poll::Done(outcome) => {
                        let p = waiters.remove(i);
                        done.push((p.responder, outcome));
                    }
                    Poll::Pending { due_ms } => {
                        next_due = Some(next_due.map_or(due_ms, |d: f64| d.min(due_ms)));
                    }
                }
            }
            st.dirty = false;
            if !done.is_empty() {
                // Answers are written without the lock: they ask the system which windows are new.
                drop(st);
                for (responder, outcome) in done {
                    responder.ok(ReplyBody::WaitChange(to_wait_result(outcome)));
                }
                st = locked(self);
                if st.dirty {
                    continue;
                }
            }
            st = match next_due {
                None => match self.wake.wait(st) {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                },
                Some(due) => {
                    let wait = Duration::from_secs_f64(((due - self.now_ms()).max(0.0)) / 1000.0);
                    match self.wake.wait_timeout(st, wait) {
                        Ok((g, _)) => g,
                        Err(p) => p.into_inner().0,
                    }
                }
            };
        }
    }
}

fn to_wait_result(outcome: Outcome) -> WaitResult {
    match outcome {
        Outcome::TimedOut { settled_ms } => WaitResult::TimedOut { settled_ms },
        Outcome::Changed {
            settled,
            first_event_ms,
            settled_ms,
            events,
            new_roots,
        } => WaitResult::Changed {
            settled,
            first_event_ms,
            settled_ms,
            events,
            new_windows: new_roots
                .into_iter()
                .map(enumerate::hwnd_from)
                .filter(|h| enumerate::is_listed(*h))
                .map(|h| window_id::format(enumerate::hwnd_value(h), enumerate::pid_of(h)))
                .collect(),
        },
    }
}
