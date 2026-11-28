//! `act`: do one thing to one control through the pattern it offers.
//!
//! The helper never clicks for the caller. A control that offers no pattern
//! for the action is refused (`background_unavailable`) and the caller
//! decides what to do next; a control that is off (or read-only) is refused
//! (`disabled`). Both refusals come before anything is sent, so a retry is
//! safe. This file holds the wire shapes and the decisions that need no
//! Windows: which pattern an action needs, what a refusal looks like and what
//! a read-back has to show for an action to count as verified.

use crate::protocol::{Action, ExpandState, Fingerprint, ToggleState};
use serde::{Deserialize, Serialize};

/// The longest text one `setValue` may carry, in characters.
pub const MAX_VALUE_CHARS: usize = 1_000_000;
/// The most steps one `scroll` takes in each direction.
pub const MAX_SCROLL_STEPS: u32 = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActKind {
    Invoke,
    SetValue,
    Toggle,
    Expand,
    Collapse,
    Select,
    ScrollIntoView,
    Scroll,
    Focus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActRequest {
    pub window_id: String,
    /// A ref from a snapshot (`r<revision>.<index>`), usable while its read is
    /// one of the two the helper holds. Exactly one of `ref` and `fingerprint`.
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    /// Finds the control again after the window changed; a fresh read is made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<Fingerprint>,
    pub action: ActKind,
    /// For `setValue`: the new text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// For `scroll`: steps right (positive) or left, and down (positive) or up.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dx: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dy: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

impl ActRequest {
    pub const DEFAULT_TIMEOUT_MS: u64 = 8_000;

    pub fn timeout_ms(&self) -> u64 {
        self.timeout_ms.unwrap_or(Self::DEFAULT_TIMEOUT_MS)
    }

    /// Which control the request names.
    pub fn target(&self) -> Result<ActTarget<'_>, String> {
        match (&self.reference, &self.fingerprint) {
            (Some(r), None) => Ok(ActTarget::Ref(r)),
            (None, Some(f)) => Ok(ActTarget::Fingerprint(f)),
            (Some(_), Some(_)) => Err("name the control by ref or by fingerprint, not both".into()),
            (None, None) => Err("act needs a ref or a fingerprint".into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActTarget<'a> {
    Ref(&'a str),
    Fingerprint(&'a Fingerprint),
}

/// What a control reads as. Only what the action's pattern has is filled in,
/// and a password's text is never read.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toggle: Option<ToggleState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expand: Option<ExpandState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActVia {
    /// The control's own pattern. The only way the helper acts.
    Pattern,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActReply {
    /// The pattern call went through.
    pub done: bool,
    pub via: ActVia,
    /// Whether the read-back shows the effect: absent for an action that has
    /// no state to read (an invoke, a scroll) or one that cannot be read (a password).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified: Option<bool>,
    /// The control as it reads after the action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<ActState>,
    /// The control's position in the read that found it, and that read's
    /// revision: after a fingerprint, refs of that revision name the window.
    pub index: u32,
    pub revision: u64,
}

/// What the control is, as far as an action cares.
#[derive(Debug, Clone)]
pub struct Facts<'a> {
    pub actions: &'a [Action],
    pub enabled: bool,
    pub expand: Option<ExpandState>,
    /// The control's value pattern is read-only.
    pub read_only: bool,
}

/// What to do, with the arguments checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    Invoke,
    SetValue(String),
    Toggle,
    Expand,
    Collapse,
    Select,
    ScrollIntoView,
    /// Signed steps, right and down positive, each within [`MAX_SCROLL_STEPS`].
    Scroll {
        dx: i32,
        dy: i32,
    },
    Focus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The arguments do not make an action (`bad_request`).
    BadArgs(String),
    /// The control offers no pattern for it (`background_unavailable`).
    NoPattern(String),
    /// The control is off or read-only (`disabled`).
    Disabled(String),
}

impl Refusal {
    pub fn message(&self) -> &str {
        match self {
            Refusal::BadArgs(m) | Refusal::NoPattern(m) | Refusal::Disabled(m) => m,
        }
    }
}

fn needs(actions: &[Action], action: Action, what: &str) -> Result<(), Refusal> {
    if actions.contains(&action) {
        Ok(())
    } else {
        Err(Refusal::NoPattern(format!(
            "this control cannot be asked to {what} without a click or keys; use the pointer or the keyboard instead"
        )))
    }
}

fn on(enabled: bool) -> Result<(), Refusal> {
    if enabled {
        Ok(())
    } else {
        Err(Refusal::Disabled("the control is turned off".into()))
    }
}

fn steps(d: i32) -> i32 {
    d.clamp(-(MAX_SCROLL_STEPS as i32), MAX_SCROLL_STEPS as i32)
}

/// Checks `request` against what the control is. Nothing has been sent when this refuses.
pub fn plan(request: &ActRequest, facts: &Facts<'_>) -> Result<Plan, Refusal> {
    match request.action {
        ActKind::Invoke => {
            needs(facts.actions, Action::Invoke, "press it")?;
            on(facts.enabled)?;
            Ok(Plan::Invoke)
        }
        ActKind::SetValue => {
            let text = request
                .text
                .as_deref()
                .ok_or_else(|| Refusal::BadArgs("setValue needs text".into()))?;
            if text.chars().count() > MAX_VALUE_CHARS {
                return Err(Refusal::BadArgs(format!(
                    "text is longer than {MAX_VALUE_CHARS} characters"
                )));
            }
            needs(facts.actions, Action::Value, "take a value")?;
            on(facts.enabled)?;
            if facts.read_only {
                return Err(Refusal::Disabled("the control is read-only".into()));
            }
            Ok(Plan::SetValue(text.to_owned()))
        }
        ActKind::Toggle => {
            needs(facts.actions, Action::Toggle, "toggle")?;
            on(facts.enabled)?;
            Ok(Plan::Toggle)
        }
        ActKind::Expand | ActKind::Collapse => {
            let word = if request.action == ActKind::Expand {
                "expand"
            } else {
                "collapse"
            };
            needs(facts.actions, Action::ExpandCollapse, word)?;
            on(facts.enabled)?;
            if facts.expand == Some(ExpandState::Leaf) {
                return Err(Refusal::NoPattern(format!(
                    "this control has nothing to {word}"
                )));
            }
            Ok(if request.action == ActKind::Expand {
                Plan::Expand
            } else {
                Plan::Collapse
            })
        }
        ActKind::Select => {
            needs(facts.actions, Action::SelectionItem, "be selected")?;
            on(facts.enabled)?;
            Ok(Plan::Select)
        }
        ActKind::ScrollIntoView => Ok(Plan::ScrollIntoView),
        ActKind::Scroll => {
            needs(facts.actions, Action::Scroll, "scroll")?;
            let (dx, dy) = (
                steps(request.dx.unwrap_or(0)),
                steps(request.dy.unwrap_or(0)),
            );
            if dx == 0 && dy == 0 {
                return Err(Refusal::BadArgs("scroll needs a dx or a dy".into()));
            }
            Ok(Plan::Scroll { dx, dy })
        }
        ActKind::Focus => {
            on(facts.enabled)?;
            Ok(Plan::Focus)
        }
    }
}

/// Whether a read-back shows `plan` took effect. `None` when there is nothing
/// to compare (an invoke has no state; a password cannot be read).
pub fn verify(plan: &Plan, before: &ActState, after: &ActState) -> Option<bool> {
    match plan {
        Plan::SetValue(text) => after.value.as_ref().map(|v| v == text),
        Plan::Toggle => match (before.toggle, after.toggle) {
            (Some(b), Some(a)) => Some(a != b),
            _ => None,
        },
        Plan::Expand => after.expand.map(|e| e == ExpandState::Expanded),
        Plan::Collapse => after.expand.map(|e| e == ExpandState::Collapsed),
        Plan::Select => after.selected,
        Plan::Focus => after.focused,
        Plan::Invoke | Plan::Scroll { .. } | Plan::ScrollIntoView => None,
    }
}

/// How long to wait between two read-backs of a control that does not yet show
/// the effect. A pattern call can return a moment before the application
/// repaints its own state, so the first read-back may still show the old one.
pub const SETTLE_STEP_MS: u64 = 25;

/// The most a read-back is delayed in all, however long the request's own
/// timeout is. A control still unchanged after this has not taken the action.
pub const SETTLE_MAX_MS: u64 = 1_000;

/// Whether to read the control again, and after how many milliseconds. `verdict`
/// is what `verify` said about the latest read, `waited_ms` what has been
/// waited so far, `timeout_ms` the request's own limit. Only a read that says
/// the effect is missing (`Some(false)`) is read again: `Some(true)` is done and
/// `None` (an invoke, a scroll, a password) has nothing that could settle.
pub fn settle_pause(verdict: Option<bool>, waited_ms: u64, timeout_ms: u64) -> Option<u64> {
    if verdict != Some(false) {
        return None;
    }
    let budget = SETTLE_MAX_MS.min(timeout_ms);
    let left = budget.checked_sub(waited_ms).filter(|l| *l > 0)?;
    Some(SETTLE_STEP_MS.min(left))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_effect_is_read_again_in_small_steps() {
        assert_eq!(settle_pause(Some(false), 0, 8_000), Some(SETTLE_STEP_MS));
        assert_eq!(settle_pause(Some(false), 975, 8_000), Some(SETTLE_STEP_MS));
    }

    #[test]
    fn a_shown_effect_or_nothing_to_compare_never_waits() {
        assert_eq!(settle_pause(Some(true), 0, 8_000), None);
        assert_eq!(settle_pause(None, 0, 8_000), None);
    }

    #[test]
    fn the_wait_stops_at_the_bound_and_never_overshoots_it() {
        assert_eq!(settle_pause(Some(false), SETTLE_MAX_MS, 8_000), None);
        assert_eq!(settle_pause(Some(false), SETTLE_MAX_MS + 5, 8_000), None);
        assert_eq!(
            settle_pause(Some(false), SETTLE_MAX_MS - 10, 8_000),
            Some(10)
        );
    }

    #[test]
    fn the_requests_timeout_caps_the_wait() {
        assert_eq!(settle_pause(Some(false), 0, 0), None);
        assert_eq!(settle_pause(Some(false), 0, 10), Some(10));
        assert_eq!(settle_pause(Some(false), 10, 10), None);
    }

    #[test]
    fn a_full_loop_spends_no_more_than_the_bound() {
        let (mut waited, mut reads) = (0, 0);
        while let Some(p) = settle_pause(Some(false), waited, 8_000) {
            waited += p;
            reads += 1;
        }
        assert_eq!(waited, SETTLE_MAX_MS);
        assert_eq!(reads, SETTLE_MAX_MS / SETTLE_STEP_MS);
    }

    fn req(action: ActKind) -> ActRequest {
        ActRequest {
            window_id: "w:1".into(),
            reference: Some("r1.0".into()),
            fingerprint: None,
            action,
            text: None,
            dx: None,
            dy: None,
            timeout_ms: None,
        }
    }

    fn facts(actions: &[Action]) -> Facts<'_> {
        Facts {
            actions,
            enabled: true,
            expand: None,
            read_only: false,
        }
    }

    #[test]
    fn a_target_is_one_of_ref_and_fingerprint() {
        let mut r = req(ActKind::Invoke);
        assert_eq!(r.target(), Ok(ActTarget::Ref("r1.0")));
        r.reference = None;
        assert!(r.target().is_err());
    }

    #[test]
    fn an_action_needs_its_pattern() {
        let none: [Action; 0] = [];
        let e = plan(&req(ActKind::Invoke), &facts(&none)).unwrap_err();
        assert!(matches!(e, Refusal::NoPattern(_)));
        assert_eq!(
            plan(&req(ActKind::Invoke), &facts(&[Action::Invoke])),
            Ok(Plan::Invoke)
        );
    }

    #[test]
    fn a_control_that_is_off_is_refused() {
        let mut f = facts(&[Action::Toggle]);
        f.enabled = false;
        assert!(matches!(
            plan(&req(ActKind::Toggle), &f),
            Err(Refusal::Disabled(_))
        ));
    }

    #[test]
    fn set_value_checks_text_and_read_only() {
        let a = [Action::Value];
        assert!(matches!(
            plan(&req(ActKind::SetValue), &facts(&a)),
            Err(Refusal::BadArgs(_))
        ));
        let mut r = req(ActKind::SetValue);
        r.text = Some("hi".into());
        assert_eq!(plan(&r, &facts(&a)), Ok(Plan::SetValue("hi".into())));
        let mut f = facts(&a);
        f.read_only = true;
        assert!(matches!(plan(&r, &f), Err(Refusal::Disabled(_))));
        r.text = Some("x".repeat(MAX_VALUE_CHARS + 1));
        assert!(matches!(plan(&r, &facts(&a)), Err(Refusal::BadArgs(_))));
    }

    #[test]
    fn a_leaf_cannot_be_expanded() {
        let a = [Action::ExpandCollapse];
        let mut f = facts(&a);
        f.expand = Some(ExpandState::Leaf);
        assert!(plan(&req(ActKind::Expand), &f).is_err());
        f.expand = Some(ExpandState::Collapsed);
        assert_eq!(plan(&req(ActKind::Expand), &f), Ok(Plan::Expand));
        assert_eq!(plan(&req(ActKind::Collapse), &f), Ok(Plan::Collapse));
    }

    #[test]
    fn scroll_steps_are_signed_and_capped() {
        let a = [Action::Scroll];
        let mut r = req(ActKind::Scroll);
        assert!(matches!(plan(&r, &facts(&a)), Err(Refusal::BadArgs(_))));
        r.dy = Some(500);
        r.dx = Some(-2);
        assert_eq!(plan(&r, &facts(&a)), Ok(Plan::Scroll { dx: -2, dy: 50 }));
    }

    #[test]
    fn verification_reads_what_each_action_changes() {
        let off = ActState {
            toggle: Some(ToggleState::Off),
            ..Default::default()
        };
        let on = ActState {
            toggle: Some(ToggleState::On),
            ..Default::default()
        };
        assert_eq!(verify(&Plan::Toggle, &off, &on), Some(true));
        assert_eq!(verify(&Plan::Toggle, &off, &off), Some(false));
        assert_eq!(verify(&Plan::Toggle, &ActState::default(), &on), None);
        let typed = ActState {
            value: Some("hi".into()),
            ..Default::default()
        };
        assert_eq!(
            verify(&Plan::SetValue("hi".into()), &off, &typed),
            Some(true)
        );
        assert_eq!(
            verify(&Plan::SetValue("ho".into()), &off, &typed),
            Some(false)
        );
        assert_eq!(
            verify(&Plan::SetValue("hi".into()), &off, &ActState::default()),
            None
        );
        assert_eq!(verify(&Plan::Invoke, &off, &on), None);
        let open = ActState {
            expand: Some(ExpandState::Expanded),
            ..Default::default()
        };
        assert_eq!(verify(&Plan::Expand, &off, &open), Some(true));
        assert_eq!(verify(&Plan::Collapse, &off, &open), Some(false));
    }
}
