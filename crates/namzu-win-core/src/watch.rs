//! What the helper tells about the controls a person uses, without any input
//! hook: which control was invoked, focused or selected, which menu or window
//! opened or closed, what an ordinary edit field now says, and which program
//! came to the front.
//!
//! The helper learns of these through read-only UI Automation subscriptions and
//! the foreground window event. Nothing here is about raw input: no key, no
//! character typed, no mouse button and no position is ever part of an event,
//! and no input device is registered for. Text is the *value of an ordinary
//! edit control*, read when the control reports a change; a password field
//! (`IsPassword`) produces a `secure` marker and never a value.
//!
//! The queue is bounded: a value change that repeats is merged into the one
//! not yet polled, past the cap new events are dropped and counted, and every
//! text is cut to a length given by the caps. The parts that decide this are
//! plain Rust so they are tested on any platform.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

/// Events kept for a poller; past this new ones are dropped and counted.
pub const MAX_QUEUE: usize = 2_000;
/// The default queue length.
pub const DEFAULT_QUEUE: usize = 2_000;
/// The default time within which repeated value changes of one control are one event, ms.
pub const DEFAULT_COALESCE_MS: u64 = 250;
/// The longest coalescing window a caller may ask for, ms.
pub const MAX_COALESCE_MS: u64 = 5_000;
/// The default and largest text of a `value`, in characters.
pub const DEFAULT_VALUE_CHARS: usize = 200;
pub const MAX_VALUE_CHARS: usize = 200;
/// The default and largest control name, in characters.
pub const DEFAULT_NAME_CHARS: usize = 80;
pub const MAX_NAME_CHARS: usize = 80;
/// The longest window title, in characters.
pub const MAX_WINDOW_CHARS: usize = 120;
/// The longest program name, in characters.
pub const MAX_PROCESS_CHARS: usize = 80;

/// What a subscription reports. Spelled as the wire spells it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WatchKind {
    /// A control was invoked (a button pressed, a menu item chosen).
    Invoke,
    /// Keyboard focus moved to a control.
    Focus,
    /// An item was selected.
    Selection,
    /// A menu opened or closed.
    Menu,
    /// A window opened or closed.
    Window,
    /// An ordinary edit control's text changed.
    Value,
    /// A program came to the front.
    App,
}

impl WatchKind {
    pub const ALL: [WatchKind; 7] = [
        WatchKind::Invoke,
        WatchKind::Focus,
        WatchKind::Selection,
        WatchKind::Menu,
        WatchKind::Window,
        WatchKind::Value,
        WatchKind::App,
    ];
}

/// The two ends of a menu or window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Open,
    Close,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStartRequest {
    /// What to watch; default every kind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<WatchKind>>,
    /// Repeated value changes of one control within this many ms are one event
    /// (default 250, at most 5000; 0 keeps every change).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coalesce_ms: Option<u64>,
    /// Events kept between polls (default and most 2000).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_queue: Option<u32>,
    /// Characters of a `value` kept (default and most 200).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_value: Option<u32>,
    /// Characters of a control `name` kept (default and most 80).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_name: Option<u32>,
}

/// The request with its defaults applied and its limits enforced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchConfig {
    pub kinds: Vec<WatchKind>,
    pub coalesce_ms: u64,
    pub max_queue: usize,
    pub max_value: usize,
    pub max_name: usize,
}

impl Default for WatchConfig {
    fn default() -> Self {
        WatchStartRequest::default().config()
    }
}

impl WatchStartRequest {
    pub fn config(&self) -> WatchConfig {
        let mut kinds = match &self.kinds {
            Some(k) if !k.is_empty() => k.clone(),
            _ => WatchKind::ALL.to_vec(),
        };
        kinds.dedup();
        let cap = |v: Option<u32>, default: usize, max: usize| {
            v.map_or(default, |n| (n as usize).clamp(1, max))
        };
        WatchConfig {
            kinds,
            coalesce_ms: self
                .coalesce_ms
                .map_or(DEFAULT_COALESCE_MS, |n| n.min(MAX_COALESCE_MS)),
            max_queue: cap(self.max_queue, DEFAULT_QUEUE, MAX_QUEUE),
            max_value: cap(self.max_value, DEFAULT_VALUE_CHARS, MAX_VALUE_CHARS),
            max_name: cap(self.max_name, DEFAULT_NAME_CHARS, MAX_NAME_CHARS),
        }
    }
}

impl WatchConfig {
    pub fn wants(&self, kind: WatchKind) -> bool {
        self.kinds.contains(&kind)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStartReply {
    /// UI Automation subscriptions are in place; false means the controls of
    /// programs are not watched (the foreground still may be).
    pub controls: bool,
    /// Foreground changes are hooked.
    pub foreground: bool,
    /// The kinds being watched.
    pub kinds: Vec<WatchKind>,
}

/// Reads what the poller has not yet taken.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct WatchPollRequest {}

/// One thing that happened, as the poller sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    pub kind: WatchKind,
    /// Monotonic ms since the watch started.
    pub t_ms: u64,
    /// The control's role (`Button`, `Edit`, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// The control's name, cut to the cap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// An ordinary edit control's text, cut to the cap; never for a secure field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// The control is a password field: its text was not read.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub secure: bool,
    /// For a menu or a window: which end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<Phase>,
    /// The title of the window the control is in, cut to the cap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
    /// The program's file name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<String>,
    /// The window as `windows` names it, when the control is in one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchPollReply {
    /// Events since the last poll, oldest first.
    pub events: Vec<WatchEvent>,
    /// Events not kept since the last poll because the queue was full.
    pub dropped: u64,
}

/// What a subscription handler read, before the caps and the secure rule.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RawWatch {
    pub kind: Option<WatchKind>,
    pub t_ms: u64,
    pub role: Option<String>,
    pub name: Option<String>,
    /// The control's text, when it was read (never for a secure field).
    pub value: Option<String>,
    pub secure: bool,
    pub phase: Option<Phase>,
    pub window: Option<String>,
    pub process: Option<String>,
    pub window_id: Option<String>,
    /// Names one control for coalescing (its runtime id); `None` never merges.
    pub key: Option<String>,
}

/// Whether a role's text is an ordinary edit field's: the only text that is read.
pub fn is_edit_role(role: &str) -> bool {
    role == "Edit"
}

/// At most `max` characters of `text`.
pub fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn cut_opt(text: Option<&str>, max: usize) -> Option<String> {
    text.filter(|t| !t.is_empty()).map(|t| cut(t, max))
}

#[derive(Debug)]
struct Queued {
    event: WatchEvent,
    key: Option<String>,
}

/// The bounded queue between the subscriptions and `watch.poll`.
#[derive(Debug)]
pub struct WatchQueue {
    config: WatchConfig,
    queue: VecDeque<Queued>,
    dropped: u64,
}

impl WatchQueue {
    pub fn new(config: WatchConfig) -> WatchQueue {
        WatchQueue {
            config,
            queue: VecDeque::new(),
            dropped: 0,
        }
    }

    pub fn config(&self) -> &WatchConfig {
        &self.config
    }

    /// Takes in what a handler read. Returns false when the event was not
    /// kept: a kind not asked for, a value from a control that is not an
    /// ordinary edit field, or a full queue (which is counted).
    pub fn record(&mut self, raw: RawWatch) -> bool {
        let Some(kind) = raw.kind else { return false };
        if !self.config.wants(kind) {
            return false;
        }
        let edit = raw.role.as_deref().is_some_and(is_edit_role);
        if kind == WatchKind::Value && !edit {
            return false;
        }
        let cfg = &self.config;
        // A secure field is a marker: its text is dropped here whatever the
        // caller passed, so a handler that forgot cannot leak it.
        let value = if raw.secure || kind != WatchKind::Value {
            None
        } else {
            raw.value.as_deref().map(|v| cut(v, cfg.max_value))
        };
        let event = WatchEvent {
            kind,
            t_ms: raw.t_ms,
            role: raw.role.filter(|r| !r.is_empty()),
            name: cut_opt(raw.name.as_deref(), cfg.max_name),
            value,
            secure: raw.secure,
            phase: raw.phase,
            window: cut_opt(raw.window.as_deref(), MAX_WINDOW_CHARS),
            process: cut_opt(raw.process.as_deref(), MAX_PROCESS_CHARS),
            window_id: raw.window_id,
        };
        if kind == WatchKind::Value && cfg.coalesce_ms > 0 {
            if let Some(key) = raw.key.as_ref() {
                let window = cfg.coalesce_ms;
                if let Some(slot) = self
                    .queue
                    .iter_mut()
                    .rev()
                    .find(|q| q.event.kind == WatchKind::Value && q.key.as_ref() == Some(key))
                {
                    if event.t_ms.saturating_sub(slot.event.t_ms) <= window {
                        slot.event = event;
                        return true;
                    }
                }
            }
        }
        if self.queue.len() >= cfg.max_queue {
            self.dropped += 1;
            return false;
        }
        self.queue.push_back(Queued {
            event,
            key: raw.key,
        });
        true
    }

    /// Everything queued, and how many events were dropped since the last poll.
    pub fn poll(&mut self) -> WatchPollReply {
        let events = self.queue.drain(..).map(|q| q.event).collect();
        WatchPollReply {
            events,
            dropped: std::mem::take(&mut self.dropped),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(kind: WatchKind, t: u64) -> RawWatch {
        RawWatch {
            kind: Some(kind),
            t_ms: t,
            ..RawWatch::default()
        }
    }

    fn edit(t: u64, value: &str, key: &str) -> RawWatch {
        RawWatch {
            role: Some("Edit".into()),
            name: Some("Search".into()),
            value: Some(value.into()),
            key: Some(key.into()),
            ..raw(WatchKind::Value, t)
        }
    }

    #[test]
    fn defaults_and_limits() {
        let c = WatchStartRequest::default().config();
        assert_eq!(c.kinds, WatchKind::ALL.to_vec());
        assert_eq!(
            (c.coalesce_ms, c.max_queue, c.max_value, c.max_name),
            (250, 2_000, 200, 80)
        );
        let c = WatchStartRequest {
            kinds: Some(vec![]),
            coalesce_ms: Some(60_000),
            max_queue: Some(999_999),
            max_value: Some(0),
            max_name: Some(10_000),
        }
        .config();
        assert_eq!(c.kinds, WatchKind::ALL.to_vec());
        assert_eq!(
            (c.coalesce_ms, c.max_queue, c.max_value, c.max_name),
            (5_000, 2_000, 1, 80)
        );
    }

    #[test]
    fn repeated_value_changes_of_one_control_are_one_event() {
        let mut q = WatchQueue::new(WatchConfig::default());
        for (i, v) in ["o", "ov", "ove", "over"].iter().enumerate() {
            assert!(q.record(edit(i as u64 * 100, v, "a")));
        }
        let r = q.poll();
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.events[0].value.as_deref(), Some("over"));
        assert_eq!(r.events[0].t_ms, 300);
    }

    #[test]
    fn a_pause_longer_than_the_window_starts_a_new_event() {
        let mut q = WatchQueue::new(WatchConfig::default());
        q.record(edit(0, "a", "a"));
        q.record(edit(1_000, "ab", "a"));
        assert_eq!(q.poll().events.len(), 2);
    }

    #[test]
    fn two_controls_are_never_merged() {
        let mut q = WatchQueue::new(WatchConfig::default());
        q.record(edit(0, "a", "a"));
        q.record(edit(10, "b", "b"));
        assert_eq!(q.poll().events.len(), 2);
    }

    #[test]
    fn coalescing_can_be_turned_off() {
        let cfg = WatchStartRequest {
            coalesce_ms: Some(0),
            ..Default::default()
        }
        .config();
        let mut q = WatchQueue::new(cfg);
        q.record(edit(0, "a", "a"));
        q.record(edit(1, "ab", "a"));
        assert_eq!(q.poll().events.len(), 2);
    }

    #[test]
    fn a_polled_event_is_not_rewritten() {
        let mut q = WatchQueue::new(WatchConfig::default());
        q.record(edit(0, "a", "a"));
        assert_eq!(q.poll().events.len(), 1);
        q.record(edit(10, "ab", "a"));
        assert_eq!(q.poll().events[0].value.as_deref(), Some("ab"));
    }

    #[test]
    fn a_secure_field_is_a_marker_and_never_a_value() {
        let mut q = WatchQueue::new(WatchConfig::default());
        // The handler passed a value by mistake: it must not survive.
        let mut r = edit(0, "hunter2", "p");
        r.secure = true;
        assert!(q.record(r));
        let e = &q.poll().events[0];
        assert!(e.secure);
        assert_eq!(e.value, None);
        let json = serde_json::to_string(e).unwrap();
        assert!(!json.contains("hunter2"), "{json}");
    }

    #[test]
    fn only_ordinary_edit_controls_report_text() {
        let mut q = WatchQueue::new(WatchConfig::default());
        let mut r = edit(0, "big document", "d");
        r.role = Some("Document".into());
        assert!(!q.record(r));
        // A focus event never carries a value either.
        let mut f = edit(1, "x", "e");
        f.kind = Some(WatchKind::Focus);
        assert!(q.record(f));
        let r = q.poll();
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.events[0].value, None);
    }

    #[test]
    fn texts_are_cut_to_their_caps() {
        let mut q = WatchQueue::new(WatchConfig::default());
        let mut r = edit(0, &"v".repeat(500), "a");
        r.name = Some("n".repeat(500));
        r.window = Some("w".repeat(500));
        r.process = Some("p".repeat(500));
        q.record(r);
        let e = &q.poll().events[0];
        assert_eq!(e.value.as_ref().unwrap().chars().count(), 200);
        assert_eq!(e.name.as_ref().unwrap().chars().count(), 80);
        assert_eq!(e.window.as_ref().unwrap().chars().count(), 120);
        assert_eq!(e.process.as_ref().unwrap().chars().count(), 80);
    }

    #[test]
    fn a_cut_never_splits_a_character() {
        assert_eq!(cut("ağıt", 2), "ağ");
        assert_eq!(cut("😀😀😀", 2), "😀😀");
    }

    #[test]
    fn a_full_queue_drops_new_events_and_counts_them() {
        let cfg = WatchStartRequest {
            max_queue: Some(3),
            ..Default::default()
        }
        .config();
        let mut q = WatchQueue::new(cfg);
        for t in 0..5 {
            q.record(raw(WatchKind::Invoke, t));
        }
        let r = q.poll();
        assert_eq!(r.events.len(), 3);
        assert_eq!(r.dropped, 2);
        // The count is per poll.
        assert_eq!(q.poll().dropped, 0);
    }

    #[test]
    fn a_merge_into_a_full_queue_is_not_a_drop() {
        let cfg = WatchStartRequest {
            max_queue: Some(1),
            ..Default::default()
        }
        .config();
        let mut q = WatchQueue::new(cfg);
        q.record(edit(0, "a", "a"));
        assert!(q.record(edit(10, "ab", "a")));
        assert_eq!(q.poll().dropped, 0);
    }

    #[test]
    fn kinds_not_asked_for_are_not_kept() {
        let cfg = WatchStartRequest {
            kinds: Some(vec![WatchKind::Invoke]),
            ..Default::default()
        }
        .config();
        let mut q = WatchQueue::new(cfg);
        assert!(!q.record(raw(WatchKind::Focus, 0)));
        assert!(q.record(raw(WatchKind::Invoke, 1)));
        assert_eq!(q.poll().events.len(), 1);
    }

    #[test]
    fn events_say_nothing_about_keys_or_buttons() {
        let mut q = WatchQueue::new(WatchConfig::default());
        q.record(edit(0, "text", "a"));
        for kind in WatchKind::ALL {
            q.record(raw(kind, 1));
        }
        let json = serde_json::to_string(&q.poll()).unwrap();
        let fields: Vec<&str> = json.split('"').collect();
        for forbidden in ["key", "vkey", "scan", "char", "button", "x", "y", "click"] {
            assert!(
                !fields.iter().any(|f| f.eq_ignore_ascii_case(forbidden)),
                "{forbidden} in {json}"
            );
        }
    }

    #[test]
    fn wire_spelling() {
        let r: WatchStartRequest = serde_json::from_str(
            r#"{"kinds":["invoke","app"],"coalesceMs":100,"maxQueue":10,"maxValue":20,"maxName":5}"#,
        )
        .unwrap();
        assert_eq!(r.kinds, Some(vec![WatchKind::Invoke, WatchKind::App]));
        assert!(serde_json::from_str::<WatchStartRequest>(r#"{"kinds":["keys"]}"#).is_err());
    }
}
