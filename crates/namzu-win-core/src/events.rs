//! The stream of changes `wait_change` listens to, and the wait itself.
//!
//! Two kinds of source write into one log: accessibility events (a window's
//! structure or a property of one of its controls changed) and system window
//! events (a window was created, shown, hidden, moved, renamed). A wait
//! counts the events that concern its window after a marker, and resolves
//! once at least one arrived and the window then stayed quiet for `quietMs`,
//! or at `timeoutMs`. Nothing here sleeps or reads a clock: the caller hands
//! in the time, so the logic is tested with a clock that is only a number.

use crate::protocol::ChangeKind;

/// Events kept; a wait that falls further behind than this counts one change and stops counting.
pub const RING: usize = 8192;

/// Where an event came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// A UI Automation event handler.
    Accessibility,
    /// A system window event (`SetWinEventHook`).
    System,
}

/// What changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Structure,
    Property,
    Created,
    Destroyed,
    Shown,
    Hidden,
    Name,
    Value,
    Location,
}

impl Kind {
    /// The wait kinds this event answers to.
    fn class(self) -> ChangeKind {
        match self {
            Kind::Structure | Kind::Created | Kind::Destroyed | Kind::Shown | Kind::Hidden => {
                ChangeKind::Structure
            }
            Kind::Location => ChangeKind::Location,
            Kind::Property | Kind::Name | Kind::Value => ChangeKind::Property,
        }
    }

    /// A window of the program appeared, went, or changed visibility.
    fn is_window_event(self) -> bool {
        matches!(
            self,
            Kind::Created | Kind::Destroyed | Kind::Shown | Kind::Hidden
        )
    }
}

fn bit(kind: ChangeKind) -> u8 {
    match kind {
        ChangeKind::Structure => 1,
        ChangeKind::Property => 2,
        ChangeKind::Location => 4,
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Event {
    pub seq: u64,
    pub ms: f64,
    pub origin: Origin,
    pub kind: Kind,
    /// The window or object the event named.
    pub hwnd: u64,
    /// Its top-level window.
    pub root: u64,
    pub pid: u32,
    /// The event is about a top-level window itself.
    pub top: bool,
}

/// Every event seen, numbered from 1, the last [`RING`] of them kept.
#[derive(Debug)]
pub struct EventLog {
    seq: u64,
    ring: Vec<Option<Event>>,
}

impl Default for EventLog {
    fn default() -> Self {
        EventLog {
            seq: 0,
            ring: vec![None; RING],
        }
    }
}

impl EventLog {
    pub fn new() -> EventLog {
        EventLog::default()
    }

    /// The number of the last event: a marker a later wait counts from.
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// Records one event and returns its number.
    #[allow(clippy::too_many_arguments)]
    pub fn push(
        &mut self,
        ms: f64,
        origin: Origin,
        kind: Kind,
        hwnd: u64,
        root: u64,
        pid: u32,
        top: bool,
    ) -> u64 {
        self.seq += 1;
        let seq = self.seq;
        self.ring[(seq % RING as u64) as usize] = Some(Event {
            seq,
            ms,
            origin,
            kind,
            hwnd,
            root,
            pid,
            top,
        });
        seq
    }

    fn at(&self, seq: u64) -> Option<&Event> {
        self.ring[(seq % RING as u64) as usize]
            .as_ref()
            .filter(|e| e.seq == seq)
    }
}

/// How a wait ended.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Changed {
        settled: bool,
        first_event_ms: i64,
        settled_ms: u64,
        events: u32,
        /// Top-level windows of the same program that appeared, as handles.
        new_roots: Vec<u64>,
    },
    TimedOut {
        settled_ms: u64,
    },
}

/// What a wait needs to be asked again.
#[derive(Debug, Clone, PartialEq)]
pub enum Poll {
    Done(Outcome),
    /// Ask again at this time (ms), or sooner if an event arrives.
    Pending {
        due_ms: f64,
    },
}

/// What a wait is asked: which window, counted from when, how quiet, how long, which changes.
#[derive(Debug, Clone)]
pub struct WaitSpec {
    pub hwnd: u64,
    pub pid: u32,
    pub since: Option<u64>,
    pub quiet_ms: u64,
    pub timeout_ms: u64,
    /// Empty means every kind.
    pub kinds: Vec<ChangeKind>,
}

/// One wait for a window to change.
#[derive(Debug, Clone)]
pub struct Waiter {
    hwnd: u64,
    pid: u32,
    scan_seq: u64,
    start_ms: f64,
    first_ms: Option<f64>,
    last_ms: Option<f64>,
    quiet_ms: f64,
    timeout_ms: f64,
    kinds: u8,
    count: u32,
    new_roots: Vec<u64>,
}

impl Waiter {
    pub const MIN_QUIET_MS: u64 = 5;
    pub const MAX_QUIET_MS: u64 = 5_000;
    pub const MIN_TIMEOUT_MS: u64 = 20;
    pub const MAX_TIMEOUT_MS: u64 = 10_000;

    /// Counts events after `spec.since` (unset, or from the future: now).
    pub fn new(log: &EventLog, now_ms: f64, spec: &WaitSpec) -> Waiter {
        let cur = log.seq();
        let scan_seq = match spec.since {
            Some(s) if s <= cur => s,
            _ => cur,
        };
        Waiter {
            hwnd: spec.hwnd,
            pid: spec.pid,
            scan_seq,
            start_ms: now_ms,
            first_ms: None,
            last_ms: None,
            quiet_ms: spec.quiet_ms.clamp(Self::MIN_QUIET_MS, Self::MAX_QUIET_MS) as f64,
            timeout_ms: spec
                .timeout_ms
                .clamp(Self::MIN_TIMEOUT_MS, Self::MAX_TIMEOUT_MS) as f64,
            kinds: if spec.kinds.is_empty() {
                7
            } else {
                spec.kinds.iter().fold(0, |m, k| m | bit(*k))
            },
            count: 0,
            new_roots: Vec::new(),
        }
    }

    fn concerns(&self, e: &Event) -> bool {
        if bit(e.kind.class()) & self.kinds == 0 {
            return false;
        }
        match e.origin {
            Origin::Accessibility => e.hwnd == self.hwnd,
            Origin::System => {
                e.root == self.hwnd || (e.pid == self.pid && e.top && e.kind.is_window_event())
            }
        }
    }

    fn scan(&mut self, log: &EventLog, now: f64) {
        let cur = log.seq();
        let mut from = self.scan_seq as i64 + 1;
        if cur as i64 - from >= RING as i64 {
            // Fell behind the ring: whatever was lost counts as one change.
            self.count += 1;
            self.first_ms.get_or_insert(now);
            self.last_ms = Some(now);
            from = cur as i64 - RING as i64 + 1;
        }
        let mut s = from.max(1) as u64;
        while s <= cur {
            if let Some(e) = log.at(s).copied().filter(|e| self.concerns(e)) {
                self.count += 1;
                self.first_ms = Some(self.first_ms.map_or(e.ms, |f| f.min(e.ms)));
                self.last_ms = Some(self.last_ms.map_or(e.ms, |l| l.max(e.ms)));
                if e.root != self.hwnd
                    && e.top
                    && matches!(e.kind, Kind::Created | Kind::Shown)
                    && !self.new_roots.contains(&e.root)
                {
                    self.new_roots.push(e.root);
                }
            }
            s += 1;
        }
        self.scan_seq = cur;
    }

    fn changed(&self, now: f64, settled: bool) -> Outcome {
        Outcome::Changed {
            settled,
            first_event_ms: (self.first_ms.unwrap_or(self.start_ms) - self.start_ms).round() as i64,
            settled_ms: (now - self.start_ms).max(0.0).round() as u64,
            events: self.count,
            new_roots: self.new_roots.clone(),
        }
    }

    /// Reads the events that arrived since the last call and says whether the wait is over.
    pub fn poll(&mut self, log: &EventLog, now: f64) -> Poll {
        self.scan(log, now);
        let elapsed = now - self.start_ms;
        if let Some(last) = self.last_ms.filter(|_| self.count > 0) {
            if now - last >= self.quiet_ms {
                return Poll::Done(self.changed(now, true));
            }
        }
        if elapsed >= self.timeout_ms {
            return Poll::Done(if self.count > 0 {
                self.changed(now, false)
            } else {
                Outcome::TimedOut {
                    settled_ms: elapsed.max(0.0).round() as u64,
                }
            });
        }
        let mut due = self.start_ms + self.timeout_ms;
        if let Some(last) = self.last_ms.filter(|_| self.count > 0) {
            due = due.min(last + self.quiet_ms);
        }
        Poll::Pending {
            due_ms: due.max(now + 0.5),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: u64 = 0x10a2c;

    fn ax(log: &mut EventLog, ms: f64, kind: Kind) {
        log.push(ms, Origin::Accessibility, kind, W, W, 77, false);
    }

    fn spec(since: Option<u64>, quiet_ms: u64, timeout_ms: u64, kinds: &[ChangeKind]) -> WaitSpec {
        WaitSpec {
            hwnd: W,
            pid: 77,
            since,
            quiet_ms,
            timeout_ms,
            kinds: kinds.to_vec(),
        }
    }

    fn waiter(log: &EventLog, now: f64, since: Option<u64>) -> Waiter {
        Waiter::new(log, now, &spec(since, 120, 2_000, &[]))
    }

    #[test]
    fn nothing_happens_until_the_timeout() {
        let log = EventLog::new();
        let mut w = waiter(&log, 1_000.0, None);
        assert_eq!(w.poll(&log, 1_500.0), Poll::Pending { due_ms: 3_000.0 });
        assert_eq!(
            w.poll(&log, 3_000.0),
            Poll::Done(Outcome::TimedOut { settled_ms: 2_000 })
        );
    }

    #[test]
    fn a_change_settles_after_the_quiet_period() {
        let mut log = EventLog::new();
        let mut w = waiter(&log, 1_000.0, None);
        ax(&mut log, 1_050.0, Kind::Structure);
        assert_eq!(w.poll(&log, 1_060.0), Poll::Pending { due_ms: 1_170.0 });
        ax(&mut log, 1_100.0, Kind::Property);
        assert_eq!(w.poll(&log, 1_150.0), Poll::Pending { due_ms: 1_220.0 });
        assert_eq!(
            w.poll(&log, 1_220.0),
            Poll::Done(Outcome::Changed {
                settled: true,
                first_event_ms: 50,
                settled_ms: 220,
                events: 2,
                new_roots: vec![]
            })
        );
    }

    #[test]
    fn changes_that_never_stop_end_unsettled_at_the_timeout() {
        let mut log = EventLog::new();
        let mut w = Waiter::new(&log, 0.0, &spec(None, 120, 200, &[]));
        let mut t = 10.0;
        while t < 200.0 {
            ax(&mut log, t, Kind::Property);
            assert!(matches!(w.poll(&log, t), Poll::Pending { .. }));
            t += 50.0;
        }
        match w.poll(&log, 200.0) {
            Poll::Done(Outcome::Changed {
                settled, events, ..
            }) => {
                assert!(!settled);
                assert_eq!(events, 4);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_marker_counts_changes_that_came_before_the_wait_began() {
        let mut log = EventLog::new();
        let since = log.seq();
        ax(&mut log, 900.0, Kind::Structure);
        let mut w = waiter(&log, 1_000.0, Some(since));
        match w.poll(&log, 1_200.0) {
            Poll::Done(Outcome::Changed {
                first_event_ms,
                events,
                ..
            }) => {
                assert_eq!((first_event_ms, events), (-100, 1));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_marker_from_the_future_means_now() {
        let mut log = EventLog::new();
        ax(&mut log, 1.0, Kind::Structure);
        let mut w = waiter(&log, 10.0, Some(99));
        assert_eq!(w.poll(&log, 20.0), Poll::Pending { due_ms: 2_010.0 });
    }

    #[test]
    fn kinds_filter_what_counts() {
        let mut log = EventLog::new();
        let mut w = Waiter::new(&log, 0.0, &spec(None, 120, 500, &[ChangeKind::Location]));
        ax(&mut log, 10.0, Kind::Structure);
        ax(&mut log, 20.0, Kind::Property);
        log.push(30.0, Origin::System, Kind::Name, W, W, 77, true);
        assert!(matches!(w.poll(&log, 40.0), Poll::Pending { .. }));
        log.push(50.0, Origin::System, Kind::Location, W, W, 77, true);
        assert!(matches!(w.poll(&log, 60.0), Poll::Pending { .. }));
        assert!(matches!(
            w.poll(&log, 200.0),
            Poll::Done(Outcome::Changed { events: 1, .. })
        ));
    }

    #[test]
    fn an_accessibility_event_of_another_window_is_not_ours() {
        let mut log = EventLog::new();
        let mut w = waiter(&log, 0.0, None);
        log.push(
            5.0,
            Origin::Accessibility,
            Kind::Structure,
            99,
            99,
            78,
            false,
        );
        assert!(matches!(w.poll(&log, 10.0), Poll::Pending { .. }));
    }

    #[test]
    fn a_new_window_of_the_same_program_counts_and_is_reported() {
        let mut log = EventLog::new();
        let mut w = waiter(&log, 0.0, None);
        // A dialog (root 0xd1) of process 77 appears; one of another process does not count.
        log.push(5.0, Origin::System, Kind::Created, 0xd1, 0xd1, 77, true);
        log.push(6.0, Origin::System, Kind::Shown, 0xd1, 0xd1, 77, true);
        log.push(7.0, Origin::System, Kind::Created, 0xe2, 0xe2, 99, true);
        match w.poll(&log, 500.0) {
            Poll::Done(Outcome::Changed {
                events, new_roots, ..
            }) => {
                assert_eq!(events, 2);
                assert_eq!(new_roots, vec![0xd1]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_child_object_event_names_the_window_by_its_root() {
        let mut log = EventLog::new();
        let mut w = waiter(&log, 0.0, None);
        log.push(5.0, Origin::System, Kind::Name, 0xc0, W, 77, false);
        assert!(matches!(
            w.poll(&log, 500.0),
            Poll::Done(Outcome::Changed { events: 1, .. })
        ));
    }

    #[test]
    fn a_wait_that_fell_behind_the_ring_counts_one_change() {
        let mut log = EventLog::new();
        let mut w = waiter(&log, 0.0, None);
        for i in 0..(RING as u64 + 10) {
            log.push(1.0, Origin::Accessibility, Kind::Property, 5, 5, 1, false);
            let _ = i;
        }
        assert!(matches!(w.poll(&log, 500.0), Poll::Pending { .. }));
        match w.poll(&log, 700.0) {
            Poll::Done(Outcome::Changed {
                events, settled, ..
            }) => {
                assert!(settled);
                assert!(events >= 1);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn limits_are_clamped() {
        let log = EventLog::new();
        let mut w = Waiter::new(&log, 0.0, &spec(None, 1, 999_999, &[]));
        assert_eq!(
            w.poll(&log, 0.0),
            Poll::Pending { due_ms: 10_000.0 },
            "timeout is capped at ten seconds"
        );
        assert_eq!(w.quiet_ms, 5.0);
    }
}
