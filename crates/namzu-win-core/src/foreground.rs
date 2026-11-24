//! The window in front, bringing one forward, and the lease a burst of input
//! holds while it uses the user's screen.
//!
//! This is the helper's side of the foreground ladder the TypeScript package
//! keeps (`foreground/ladder.ts`): the policy (who may use the screen, when to
//! ask a person) stays there, and the primitives are here. The wire shapes and
//! the decisions that need no Windows are in this file: whether the window a
//! lease is for is still in front, whether a lease ran out, how long a person
//! has been idle once the helper's own input is left out, which window to put
//! back at the end of a burst and why not, and whether a lease file is the one
//! a token belongs to.

use crate::dpi::Point;
use serde::{Deserialize, Serialize};

/// A lease nobody refreshed for this long is over, ms. The same limit the
/// screen lease file uses.
pub const DEFAULT_TTL_MS: u64 = 30_000;
/// What an idle time that cannot be measured reads as: a day.
pub const IDLE_CAP_MS: u64 = 86_400_000;
/// Input the system registers this long after the helper stopped sending is still the helper's, ms.
pub const OWN_TAIL_MS: u64 = 300;

/// A window by handle and process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Win {
    pub hwnd: u64,
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundWindow {
    pub window_id: String,
    pub process_id: u32,
    /// The program's file name (`editor.exe`).
    pub exe: String,
    /// Windows keeps this program's input from it: it runs above this one, or cannot be inspected.
    pub elevated: bool,
    /// Its integrity level as a RID (0x2000 medium, 0x3000 high); -1 when unreadable.
    pub integrity: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundTarget {
    pub exe: String,
    pub elevated: bool,
    pub integrity: i32,
}

/// What the desktop looks like right now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundState {
    pub foreground: Option<ForegroundWindow>,
    pub cursor: Point,
    /// The input desktop's name; `Default` is the normal one, anything else is a lock screen or a prompt.
    pub desktop: String,
    /// This program runs with administrator rights.
    pub self_elevated: bool,
    pub self_integrity: i32,
    /// The system's last-input tick (`GetLastInputInfo`): it moves for any input, injected or not.
    pub input_tick: u64,
    /// How long no person has used keyboard or mouse, ms. The helper's own input is left out.
    pub user_idle_ms: u64,
    /// The process of the `windowId` the request named.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ForegroundTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundGetRequest {
    /// Also report this window's process.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    /// Also report this process (when no window of it is at hand).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundSetRequest {
    pub window_id: String,
}

/// How a window was brought forward, in the order the helper tries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RaiseHow {
    /// It was in front already.
    Already,
    Plain,
    /// After an unassigned key tap that gives this program the right to take the front.
    Unlock,
    Attach,
    Switch,
    /// Windows would not hand over the front.
    Refused,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockedBy {
    /// The foreground lock: Windows keeps the front with the program that has it.
    Windows,
    /// The window belongs to a program with more rights.
    Elevated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundSetReply {
    /// The window is in front now.
    pub raised: bool,
    /// The front changed: it was not this window before.
    pub changed: bool,
    pub how: RaiseHow,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_by: Option<BlockedBy>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseBeginRequest {
    /// The window the burst is for. While the lease is held, input is refused
    /// when no window of this window's program is in front.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    /// Bring `windowId` to the front first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raise: Option<bool>,
    /// A person must have been still this long (ms); else nothing is moved and `refused` is true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_ms: Option<u64>,
    /// The lease ends by itself this long (ms) after the last input it let through.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_ms: Option<u64>,
    /// The screen-lease file of this session and the token in it: the helper
    /// deletes the file (when the token still matches) if it ends while the
    /// lease is held, so a crash does not leave the screen locked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

impl LeaseBeginRequest {
    pub fn ttl_ms(&self) -> u64 {
        self.ttl_ms.unwrap_or(DEFAULT_TTL_MS)
    }

    /// The lease file and its token, when both are given.
    pub fn file(&self) -> Result<Option<(&str, &str)>, String> {
        match (&self.lease_path, &self.token) {
            (Some(p), Some(t)) => Ok(Some((p, t))),
            (None, None) => Ok(None),
            _ => Err("leasePath and token go together".into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseBeginReply {
    #[serde(flatten)]
    pub state: ForegroundState,
    /// A person was still using the machine: nothing was moved and no lease is held.
    pub refused: bool,
    /// With `raise`: the window is in front.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raised: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raise_how: Option<RaiseHow>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseEndRequest {
    /// Put the window and the pointer back (see [`restore_decision`]).
    pub restore: bool,
    /// With `restore`: leave the pointer where the burst put it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_cursor: Option<bool>,
    /// Also delete the lease file named at begin, when its token still matches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseEndReply {
    pub restored_foreground: bool,
    pub restored_cursor: bool,
    /// Why the window in front before the burst was not put back, when it was not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore_note: Option<String>,
    /// The system registered input between the end of `begin` and `end`. False
    /// after a burst that sent input means Windows dropped it.
    pub input_moved: bool,
    /// The window in front at the end is positively read to run above this program's rights.
    pub front_elevated: bool,
    /// The lease file was deleted.
    pub released: bool,
    /// Input events a person's keyboard and mouse produced between `begin`
    /// and `end`, as the monitor counts them. Absent when the monitor was not
    /// running for the whole burst.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inputs_during: Option<u64>,
}

// ---------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseError {
    /// The lease ran out before this call.
    Expired,
    /// The window the lease is for is not in front any more.
    ForegroundLost,
}

/// A lease the helper holds for a burst of input.
#[derive(Debug, Clone)]
pub struct Lease {
    pub target: Option<Win>,
    pub ttl_ms: u64,
    pub last_ms: f64,
    /// What was in front before the burst, and what the burst raised.
    pub before: Option<Win>,
    pub raised: Option<Win>,
    pub cursor: Point,
    /// The system's last-input tick after the raise: input that moves it is the burst's.
    pub tick: u64,
    pub file: Option<(String, String)>,
    /// The monitor's count of a person's input at `begin`, when it was running.
    pub person_inputs: Option<u64>,
}

impl Lease {
    pub fn expired(&self, now_ms: f64) -> bool {
        now_ms - self.last_ms > self.ttl_ms as f64
    }

    /// Whether input may go now. On success the lease counts as used just now.
    pub fn admit(&mut self, now_ms: f64, front: Option<Win>) -> Result<(), LeaseError> {
        if self.expired(now_ms) {
            return Err(LeaseError::Expired);
        }
        if let Some(target) = self.target {
            // Another window of the same program (a dialog, a menu) is fine.
            match front {
                Some(f) if f.pid == target.pid => {}
                _ => return Err(LeaseError::ForegroundLost),
            }
        }
        self.last_ms = now_ms;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Idle time
// ---------------------------------------------------------------------------

/// A stretch of the system's input clock the helper's own input accounts for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OwnInput {
    /// ms since the helper began sending.
    pub since_start: u64,
    /// ms since it stopped; `None` while a lease is still held.
    pub since_end: Option<u64>,
}

/// How long no person has used the machine, ms. `since_input` is the time
/// since the system last registered input of any kind; when that input falls
/// inside the helper's own sending (plus a short tail) it was the helper's, so
/// the machine reads as idle. A key or button held down is use.
pub fn user_idle_ms(since_input: u64, own: Option<OwnInput>, held: bool) -> u64 {
    if held {
        return 0;
    }
    let is_own = own.is_some_and(|o| {
        since_input <= o.since_start
            && o.since_end
                .is_none_or(|end| since_input.saturating_add(OWN_TAIL_MS) >= end)
    });
    if is_own {
        IDLE_CAP_MS
    } else {
        since_input.min(IDLE_CAP_MS)
    }
}

// ---------------------------------------------------------------------------
// Putting things back
// ---------------------------------------------------------------------------

/// What the end of a burst knows.
#[derive(Debug, Clone, Copy)]
pub struct RestoreFacts {
    pub before: Option<Win>,
    pub raised: Option<Win>,
    pub target: Option<Win>,
    pub current: Option<Win>,
    /// The window that was in front before still exists.
    pub before_alive: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restore {
    Put(Win),
    Skip(&'static str),
}

/// The window is put back only when this burst moved the front: the window it
/// raised, or, where the raise was refused and the program took the front
/// itself, the target (or another window of its program) now in front.
/// Anything else in front means a person, or a click of the burst, has moved
/// on: leave it.
pub fn restore_decision(f: &RestoreFacts) -> Restore {
    let mine = f.raised.or(f.target);
    let (Some(before), Some(mine)) = (f.before, mine) else {
        return Restore::Skip("the burst had no window to put back");
    };
    if f.current == Some(before) {
        return Restore::Skip("the window that was in front is in front again");
    }
    let current_pid = f.current.map_or(0, |c| c.pid);
    if f.current != Some(mine) && (current_pid != mine.pid || mine.pid == 0) {
        return Restore::Skip("another window was in front by then, so it was left alone");
    }
    if !f.before_alive {
        return Restore::Skip("the window that was in front is gone");
    }
    Restore::Put(before)
}

/// Whether the text of a lease file carries `token`.
pub fn lease_file_has_token(text: &str, token: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("token").and_then(|t| t.as_str()).map(|t| t == token))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(hwnd: u64, pid: u32) -> Win {
        Win { hwnd, pid }
    }

    fn lease(target: Option<Win>) -> Lease {
        Lease {
            target,
            ttl_ms: 1000,
            last_ms: 0.0,
            before: None,
            raised: None,
            cursor: Point { x: 0, y: 0 },
            tick: 0,
            file: None,
            person_inputs: None,
        }
    }

    #[test]
    fn a_lease_admits_input_for_its_window_and_its_program() {
        let mut l = lease(Some(win(10, 7)));
        assert_eq!(l.admit(100.0, Some(win(10, 7))), Ok(()));
        // A dialog of the same program.
        assert_eq!(l.admit(200.0, Some(win(11, 7))), Ok(()));
        assert_eq!(
            l.admit(300.0, Some(win(12, 8))),
            Err(LeaseError::ForegroundLost)
        );
        assert_eq!(l.admit(300.0, None), Err(LeaseError::ForegroundLost));
    }

    #[test]
    fn a_lease_runs_out_unless_it_is_used() {
        let mut l = lease(None);
        assert_eq!(l.admit(900.0, None), Ok(()));
        // Refreshed by the call above.
        assert_eq!(l.admit(1800.0, None), Ok(()));
        assert_eq!(l.admit(2900.0, None), Err(LeaseError::Expired));
        assert!(l.expired(2900.0));
    }

    #[test]
    fn a_refused_call_does_not_refresh() {
        let mut l = lease(Some(win(1, 1)));
        assert!(l.admit(500.0, Some(win(2, 2))).is_err());
        assert_eq!(l.last_ms, 0.0);
    }

    #[test]
    fn idle_leaves_out_the_helpers_own_input() {
        // A person's input 5 s ago, the helper began sending 2 s ago: not own.
        let own = OwnInput {
            since_start: 2_000,
            since_end: None,
        };
        assert_eq!(user_idle_ms(5_000, Some(own), false), 5_000);
        // Input 1 s ago is after the helper began: its own, while the lease is held.
        assert_eq!(user_idle_ms(1_000, Some(own), false), IDLE_CAP_MS);
        // After it ended 10 s ago, input 9.9 s ago is within the tail; 1 s ago is a person's.
        let ended = OwnInput {
            since_start: 12_000,
            since_end: Some(10_000),
        };
        assert_eq!(user_idle_ms(9_900, Some(ended), false), IDLE_CAP_MS);
        assert_eq!(user_idle_ms(1_000, Some(ended), false), 1_000);
        // A key held down is use.
        assert_eq!(user_idle_ms(60_000, None, true), 0);
        assert_eq!(user_idle_ms(u64::MAX, None, false), IDLE_CAP_MS);
    }

    fn facts() -> RestoreFacts {
        RestoreFacts {
            before: Some(win(1, 100)),
            raised: Some(win(2, 200)),
            target: Some(win(2, 200)),
            current: Some(win(2, 200)),
            before_alive: true,
        }
    }

    #[test]
    fn the_window_is_put_back_when_the_burst_moved_the_front() {
        assert_eq!(restore_decision(&facts()), Restore::Put(win(1, 100)));
        // Another window of the raised program is in front: still the burst's.
        let mut f = facts();
        f.current = Some(win(3, 200));
        assert_eq!(restore_decision(&f), Restore::Put(win(1, 100)));
    }

    #[test]
    fn it_is_left_alone_when_someone_else_moved_on() {
        let mut f = facts();
        f.current = Some(win(9, 900));
        assert_eq!(
            restore_decision(&f),
            Restore::Skip("another window was in front by then, so it was left alone")
        );
        f = facts();
        f.current = Some(win(1, 100));
        assert!(matches!(restore_decision(&f), Restore::Skip(n) if n.contains("in front again")));
        f = facts();
        f.before_alive = false;
        assert!(matches!(restore_decision(&f), Restore::Skip(n) if n.contains("gone")));
        f = facts();
        f.before = None;
        assert!(matches!(restore_decision(&f), Restore::Skip(n) if n.contains("no window")));
    }

    #[test]
    fn a_refused_raise_falls_back_to_the_target() {
        let mut f = facts();
        f.raised = None;
        f.current = Some(win(2, 200));
        assert_eq!(restore_decision(&f), Restore::Put(win(1, 100)));
        f.target = None;
        assert!(matches!(restore_decision(&f), Restore::Skip(_)));
    }

    #[test]
    fn a_lease_file_is_matched_by_its_token() {
        assert!(lease_file_has_token(r#"{"pid":1,"token":"abc"}"#, "abc"));
        assert!(!lease_file_has_token(r#"{"pid":1,"token":"abd"}"#, "abc"));
        assert!(!lease_file_has_token("not json", "abc"));
        assert!(!lease_file_has_token(r#"{"token":5}"#, "5"));
    }

    #[test]
    fn begin_takes_both_lease_file_fields_or_neither() {
        let mut r = LeaseBeginRequest::default();
        assert_eq!(r.file(), Ok(None));
        r.lease_path = Some("p".into());
        assert!(r.file().is_err());
        r.token = Some("t".into());
        assert_eq!(r.file(), Ok(Some(("p", "t"))));
        assert_eq!(r.ttl_ms(), DEFAULT_TTL_MS);
    }
}
