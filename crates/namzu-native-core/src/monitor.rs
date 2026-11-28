//! What the helper tells about the desk while a burst runs: that a person used
//! the keyboard or the mouse, and which window came to the front.
//!
//! The input side records a kind of device and a time and nothing else. The
//! helper learns of input through Raw Input headers (which device class sent
//! it, and whether the system synthesised it) and never reads a key, a
//! character or a scan code, so nothing here can say what a person typed.
//!
//! The log is a ring: counts are exact and never reset, events are kept for a
//! poller that asks "what happened since sequence number N", and a run of
//! mouse movement is one event, not hundreds.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// Events kept for a poller; older ones are dropped (the counts stay exact).
pub const RING: usize = 256;
/// Input of the same device and origin within this many ms of the last kept
/// event is counted but not kept again.
pub const COALESCE_MS: u64 = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Hook {
    Foreground,
    Input,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Input,
    Foreground,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Device {
    Keyboard,
    Mouse,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct MonitorStartRequest {
    /// What to watch; default both.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hooks: Option<Vec<Hook>>,
}

impl MonitorStartRequest {
    pub fn wants(&self, hook: Hook) -> bool {
        self.hooks.as_ref().is_none_or(|h| h.contains(&hook))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonitorStartReply {
    /// Raw Input is registered: a person's use of keyboard and mouse is seen.
    pub input: bool,
    /// Foreground changes are hooked.
    pub foreground: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct MonitorPollRequest {
    /// Events with a larger `seq` than this; default all that are kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
}

/// One thing that happened. Input carries only the device, a time and whether
/// the system synthesised it (the helper's own `SendInput`, another program's).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorEvent {
    pub seq: u64,
    pub kind: Kind,
    /// ms since the monitor started.
    pub t_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<Device>,
    /// For input: the system synthesised it (no physical device sent it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub injected: Option<bool>,
    /// For a foreground change: the window that came to the front.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorPollReply {
    pub events: Vec<MonitorEvent>,
    /// The last sequence number given out; 0 before any event.
    pub seq: u64,
    /// Events a person's devices produced since the monitor started. Only goes up.
    pub inputs: u64,
    /// Synthesised input seen since the monitor started.
    pub injected_inputs: u64,
    /// Foreground changes seen since the monitor started.
    pub foreground_changes: u64,
    /// ms since a person's last input, when there was one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_input_ago_ms: Option<u64>,
    /// `since` was older than the oldest event kept: some events are not in the list.
    pub dropped: bool,
}

#[derive(Debug, Default)]
pub struct MonitorLog {
    events: VecDeque<MonitorEvent>,
    next_seq: u64,
    inputs: u64,
    injected: u64,
    foreground: u64,
    last_person_ms: Option<u64>,
    /// Device, origin and time of the last input event that was kept.
    last_kept_input: Option<(Device, bool, u64)>,
}

impl MonitorLog {
    pub fn new() -> MonitorLog {
        MonitorLog::default()
    }

    fn push(&mut self, mut event: MonitorEvent) {
        self.next_seq += 1;
        event.seq = self.next_seq;
        if self.events.len() == RING {
            self.events.pop_front();
        }
        self.events.push_back(event);
    }

    /// Records one input event. Only the device class and the time are known.
    pub fn record_input(&mut self, t_ms: u64, device: Device, injected: bool) {
        if injected {
            self.injected += 1;
        } else {
            self.inputs += 1;
            self.last_person_ms = Some(t_ms);
        }
        if let Some((d, i, at)) = self.last_kept_input {
            if d == device && i == injected && t_ms.saturating_sub(at) < COALESCE_MS {
                return;
            }
        }
        self.last_kept_input = Some((device, injected, t_ms));
        self.push(MonitorEvent {
            seq: 0,
            kind: Kind::Input,
            t_ms,
            device: Some(device),
            injected: Some(injected),
            window_id: None,
        });
    }

    pub fn record_foreground(&mut self, t_ms: u64, window_id: String) {
        self.foreground += 1;
        self.push(MonitorEvent {
            seq: 0,
            kind: Kind::Foreground,
            t_ms,
            device: None,
            injected: None,
            window_id: Some(window_id),
        });
    }

    /// A person's input events so far.
    pub fn inputs(&self) -> u64 {
        self.inputs
    }

    pub fn poll(&self, since: Option<u64>, now_ms: u64) -> MonitorPollReply {
        let floor = since.unwrap_or(0);
        let oldest = self.events.front().map_or(self.next_seq + 1, |e| e.seq);
        MonitorPollReply {
            events: self
                .events
                .iter()
                .filter(|e| e.seq > floor)
                .cloned()
                .collect(),
            seq: self.next_seq,
            inputs: self.inputs,
            injected_inputs: self.injected,
            foreground_changes: self.foreground,
            last_input_ago_ms: self.last_person_ms.map(|t| now_ms.saturating_sub(t)),
            dropped: since.is_some() && floor.saturating_add(1) < oldest,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_of_movement_is_counted_but_kept_once() {
        let mut log = MonitorLog::new();
        for t in 0..10 {
            log.record_input(t * 5, Device::Mouse, false);
        }
        let r = log.poll(None, 100);
        assert_eq!(r.inputs, 10);
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.events[0].device, Some(Device::Mouse));
        assert_eq!(r.last_input_ago_ms, Some(55));
    }

    #[test]
    fn a_person_and_synthesised_input_are_told_apart() {
        let mut log = MonitorLog::new();
        log.record_input(0, Device::Keyboard, true);
        log.record_input(1, Device::Keyboard, false);
        let r = log.poll(None, 10);
        assert_eq!((r.inputs, r.injected_inputs), (1, 1));
        assert_eq!(r.events.len(), 2);
        assert_eq!(r.events[0].injected, Some(true));
        assert_eq!(r.events[1].injected, Some(false));
    }

    #[test]
    fn only_synthesised_input_leaves_a_person_unseen() {
        let mut log = MonitorLog::new();
        log.record_input(5, Device::Mouse, true);
        assert_eq!(log.poll(None, 50).last_input_ago_ms, None);
    }

    #[test]
    fn foreground_changes_are_never_merged() {
        let mut log = MonitorLog::new();
        log.record_foreground(1, "w:1".into());
        log.record_foreground(2, "w:2".into());
        let r = log.poll(None, 3);
        assert_eq!(r.foreground_changes, 2);
        assert_eq!(r.events.len(), 2);
        assert_eq!(r.events[1].window_id.as_deref(), Some("w:2"));
    }

    #[test]
    fn since_returns_only_newer_events() {
        let mut log = MonitorLog::new();
        log.record_foreground(1, "w:1".into());
        let first = log.poll(None, 1).seq;
        log.record_foreground(2, "w:2".into());
        let r = log.poll(Some(first), 2);
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.events[0].seq, first + 1);
        assert!(!r.dropped);
    }

    #[test]
    fn the_ring_drops_the_oldest_and_says_so() {
        let mut log = MonitorLog::new();
        for i in 0..(RING as u64 + 10) {
            log.record_foreground(i, format!("w:{i}"));
        }
        let r = log.poll(Some(0), 0);
        assert_eq!(r.events.len(), RING);
        assert!(r.dropped);
        assert_eq!(r.foreground_changes, RING as u64 + 10);
        // A poller that kept up is not told anything was lost.
        assert!(!log.poll(Some(r.seq - 1), 0).dropped);
    }

    #[test]
    fn events_carry_no_key_content() {
        let mut log = MonitorLog::new();
        log.record_input(1, Device::Keyboard, false);
        let json = serde_json::to_string(&log.poll(None, 2)).unwrap();
        for forbidden in ["key", "vkey", "scan", "char", "text"] {
            let fields: Vec<&str> = json.split('"').collect();
            assert!(
                !fields.iter().any(|f| f.eq_ignore_ascii_case(forbidden)),
                "{forbidden} in {json}"
            );
        }
        assert!(json.contains("\"device\":\"keyboard\""));
    }

    #[test]
    fn start_wants_both_by_default() {
        let r = MonitorStartRequest::default();
        assert!(r.wants(Hook::Input) && r.wants(Hook::Foreground));
        let r = MonitorStartRequest {
            hooks: Some(vec![Hook::Foreground]),
        };
        assert!(r.wants(Hook::Foreground) && !r.wants(Hook::Input));
    }
}
