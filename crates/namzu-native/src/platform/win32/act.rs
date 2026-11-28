//! Doing one thing to one control through its pattern, and reading the
//! control back afterwards.
//!
//! The helper never clicks and never moves the focus unless the action is
//! `focus`: a control that offers no pattern for the action is refused before
//! this file is reached (see `namzu_native_core::act::plan`). Reading back is
//! live, not from the cache the snapshot made, so it shows what the control
//! says now.

use super::uia::El;
use namzu_native_core::act::{ActState, Plan};
use namzu_native_core::protocol::{Action, ExpandState, ToggleState};
use windows::Win32::UI::Accessibility::{
    ExpandCollapseState_Collapsed, ExpandCollapseState_Expanded,
    ExpandCollapseState_PartiallyExpanded, IUIAutomationExpandCollapsePattern,
    IUIAutomationInvokePattern, IUIAutomationScrollItemPattern, IUIAutomationScrollPattern,
    IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern, IUIAutomationValuePattern,
    ScrollAmount, ScrollAmount_NoAmount, ScrollAmount_SmallDecrement, ScrollAmount_SmallIncrement,
    ToggleState_Off, ToggleState_On, UIA_ExpandCollapsePatternId, UIA_InvokePatternId,
    UIA_ScrollItemPatternId, UIA_ScrollPatternId, UIA_SelectionItemPatternId, UIA_TogglePatternId,
    UIA_ValuePatternId,
};
use windows::core::BSTR;

/// True when the control's value pattern refuses a write.
pub fn read_only(el: &El) -> bool {
    unsafe {
        el.0.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .and_then(|p| p.CurrentIsReadOnly())
            .map(|b| b.as_bool())
            .unwrap_or(false)
    }
}

/// What the control reads as now, for the patterns it offers. A password's
/// text is never read.
pub fn read_state(el: &El, actions: &[Action]) -> ActState {
    let mut state = ActState::default();
    unsafe {
        if actions.contains(&Action::Value) {
            let password =
                el.0.CurrentIsPassword()
                    .map(|b| b.as_bool())
                    .unwrap_or(false);
            if !password {
                state.value =
                    el.0.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                        .and_then(|p| p.CurrentValue())
                        .ok()
                        .map(|v| v.to_string());
            }
        }
        if actions.contains(&Action::Toggle) {
            state.toggle =
                el.0.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                    .and_then(|p| p.CurrentToggleState())
                    .ok()
                    .map(|s| {
                        if s == ToggleState_On {
                            ToggleState::On
                        } else if s == ToggleState_Off {
                            ToggleState::Off
                        } else {
                            ToggleState::Mixed
                        }
                    });
        }
        if actions.contains(&Action::ExpandCollapse) {
            state.expand =
                el.0.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                    UIA_ExpandCollapsePatternId,
                )
                .and_then(|p| p.CurrentExpandCollapseState())
                .ok()
                .map(|s| {
                    if s == ExpandCollapseState_Expanded {
                        ExpandState::Expanded
                    } else if s == ExpandCollapseState_Collapsed {
                        ExpandState::Collapsed
                    } else if s == ExpandCollapseState_PartiallyExpanded {
                        ExpandState::Partial
                    } else {
                        ExpandState::Leaf
                    }
                });
        }
        if actions.contains(&Action::SelectionItem) {
            state.selected =
                el.0.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                    UIA_SelectionItemPatternId,
                )
                .and_then(|p| p.CurrentIsSelected())
                .ok()
                .map(|b| b.as_bool());
        }
        state.focused = el.0.CurrentHasKeyboardFocus().ok().map(|b| b.as_bool());
    }
    state
}

fn amount(steps: i32) -> ScrollAmount {
    match steps {
        0 => ScrollAmount_NoAmount,
        s if s > 0 => ScrollAmount_SmallIncrement,
        _ => ScrollAmount_SmallDecrement,
    }
}

/// Makes the call the plan names. An error is the platform's own.
pub fn perform(el: &El, plan: &Plan) -> windows::core::Result<()> {
    unsafe {
        match plan {
            Plan::Invoke => {
                el.0.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)?
                    .Invoke()
            }
            Plan::SetValue(text) => {
                el.0.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)?
                    .SetValue(&BSTR::from(text.as_str()))
            }
            Plan::Toggle => {
                el.0.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)?
                    .Toggle()
            }
            Plan::Expand => {
                el.0.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                    UIA_ExpandCollapsePatternId,
                )?
                .Expand()
            }
            Plan::Collapse => {
                el.0.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                    UIA_ExpandCollapsePatternId,
                )?
                .Collapse()
            }
            Plan::Select => {
                el.0.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                    UIA_SelectionItemPatternId,
                )?
                .Select()
            }
            Plan::ScrollIntoView => {
                el.0.GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(UIA_ScrollItemPatternId)?
                    .ScrollIntoView()
            }
            Plan::Scroll { dx, dy } => {
                let pattern =
                    el.0.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)?;
                // One small step at a time, the way a wheel notch is one step.
                let (mut h, mut v) = (*dx, *dy);
                while h != 0 || v != 0 {
                    pattern.Scroll(amount(h), amount(v))?;
                    h -= h.signum();
                    v -= v.signum();
                }
                Ok(())
            }
            Plan::Focus => el.0.SetFocus(),
        }
    }
}
