//! UI Automation: reading a window's controls, naming one so it can be found
//! again, and watching a window for changes.
//!
//! One cache request brings back every property the snapshot lists for a
//! whole subtree in a single cross-process call; the controls are then read
//! from the cache. The walk, the limits and the identities are the shared
//! code in `namzu_win_core::tree`; this file only says how to read one
//! control and its children from UI Automation.

use namzu_win_core::events::{Kind, Origin};
use namzu_win_core::protocol::{Action, ExpandState, Rect, ToggleState};
use namzu_win_core::tree::{RawNode, Source, control_type_name};
use std::sync::Arc;
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, SAFEARRAY,
};
use windows::Win32::System::Ole::{SafeArrayAccessData, SafeArrayUnaccessData};
use windows::Win32::System::Variant::{VARENUM, VARIANT, VT_ARRAY, VT_BOOL, VT_I4};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, ExpandCollapseState_Collapsed, ExpandCollapseState_Expanded,
    ExpandCollapseState_PartiallyExpanded, IUIAutomation, IUIAutomationCacheRequest,
    IUIAutomationElement, IUIAutomationExpandCollapsePattern,
    IUIAutomationPropertyChangedEventHandler, IUIAutomationPropertyChangedEventHandler_Impl,
    IUIAutomationSelectionItemPattern, IUIAutomationStructureChangedEventHandler,
    IUIAutomationStructureChangedEventHandler_Impl, IUIAutomationTogglePattern,
    IUIAutomationValuePattern, StructureChangeType, ToggleState_Off, ToggleState_On, TreeScope,
    TreeScope_Children, TreeScope_Element, TreeScope_Subtree, UIA_AutomationIdPropertyId,
    UIA_BoundingRectanglePropertyId, UIA_ClassNamePropertyId, UIA_ControlTypePropertyId,
    UIA_ExpandCollapseExpandCollapseStatePropertyId, UIA_ExpandCollapsePatternId,
    UIA_HasKeyboardFocusPropertyId, UIA_IsEnabledPropertyId,
    UIA_IsExpandCollapsePatternAvailablePropertyId, UIA_IsInvokePatternAvailablePropertyId,
    UIA_IsOffscreenPropertyId, UIA_IsPasswordPropertyId, UIA_IsScrollPatternAvailablePropertyId,
    UIA_IsSelectionItemPatternAvailablePropertyId, UIA_IsTogglePatternAvailablePropertyId,
    UIA_IsValuePatternAvailablePropertyId, UIA_NamePropertyId, UIA_PROPERTY_ID,
    UIA_RuntimeIdPropertyId, UIA_SelectionItemIsSelectedPropertyId, UIA_SelectionItemPatternId,
    UIA_TogglePatternId, UIA_ToggleToggleStatePropertyId, UIA_ValuePatternId,
    UIA_ValueValuePropertyId,
};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
};
use windows::core::{Ref, implement};

use super::hub::Hub;

/// A UI Automation element that may be moved between threads: the library
/// is free-threaded, and the helper only touches elements from its worker.
#[derive(Clone)]
pub struct El(pub IUIAutomationElement);
// SAFETY: UI Automation objects are agile (the process is in the
// multithreaded apartment); a call from another thread is marshalled by COM.
unsafe impl Send for El {}
unsafe impl Sync for El {}

/// The automation object and the cache requests, made once.
pub struct Uia {
    automation: IUIAutomation,
    subtree: IUIAutomationCacheRequest,
    children: IUIAutomationCacheRequest,
}
// SAFETY: as for `El`.
unsafe impl Send for Uia {}
unsafe impl Sync for Uia {}

/// Called first on every worker thread: joins the multithreaded apartment and
/// asks for physical pixels, so rectangles are in the units the protocol uses.
pub fn init_thread() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

fn cache_request(
    automation: &IUIAutomation,
    scope: TreeScope,
) -> windows::core::Result<IUIAutomationCacheRequest> {
    unsafe {
        let request = automation.CreateCacheRequest()?;
        // The controls a person sees, not every node the provider has.
        request.SetTreeFilter(&automation.ControlViewCondition()?)?;
        request.SetTreeScope(scope)?;
        for property in [
            UIA_NamePropertyId,
            UIA_ControlTypePropertyId,
            UIA_AutomationIdPropertyId,
            UIA_ClassNamePropertyId,
            UIA_BoundingRectanglePropertyId,
            UIA_IsEnabledPropertyId,
            UIA_IsOffscreenPropertyId,
            UIA_HasKeyboardFocusPropertyId,
            UIA_RuntimeIdPropertyId,
            UIA_IsPasswordPropertyId,
            UIA_IsInvokePatternAvailablePropertyId,
            UIA_IsValuePatternAvailablePropertyId,
            UIA_IsTogglePatternAvailablePropertyId,
            UIA_IsExpandCollapsePatternAvailablePropertyId,
            UIA_IsSelectionItemPatternAvailablePropertyId,
            UIA_IsScrollPatternAvailablePropertyId,
            UIA_ValueValuePropertyId,
            UIA_ToggleToggleStatePropertyId,
            UIA_ExpandCollapseExpandCollapseStatePropertyId,
            UIA_SelectionItemIsSelectedPropertyId,
        ] {
            request.AddProperty(property)?;
        }
        for pattern in [
            UIA_ValuePatternId,
            UIA_TogglePatternId,
            UIA_ExpandCollapsePatternId,
            UIA_SelectionItemPatternId,
        ] {
            request.AddPattern(pattern)?;
        }
        Ok(request)
    }
}

impl Uia {
    /// Must be called on a thread that has run [`init_thread`].
    pub fn new() -> windows::core::Result<Uia> {
        unsafe {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            let subtree = cache_request(&automation, TreeScope_Subtree)?;
            let children = cache_request(
                &automation,
                TreeScope(TreeScope_Element.0 | TreeScope_Children.0),
            )?;
            Ok(Uia {
                automation,
                subtree,
                children,
            })
        }
    }

    pub fn element_from_window(
        &self,
        hwnd: windows::Win32::Foundation::HWND,
    ) -> windows::core::Result<El> {
        unsafe { self.automation.ElementFromHandle(hwnd).map(El) }
    }

    /// `el` with its whole subtree cached: one cross-process call.
    pub fn read_subtree(&self, el: &El) -> windows::core::Result<El> {
        unsafe { el.0.BuildUpdatedCache(&self.subtree).map(El) }
    }

    /// The reader the shared tree walk uses.
    pub fn source(&self) -> UiaSource<'_> {
        UiaSource { uia: self }
    }
}

pub struct UiaSource<'a> {
    uia: &'a Uia,
}

fn available(el: &IUIAutomationElement, property: UIA_PROPERTY_ID) -> bool {
    unsafe {
        match el.GetCachedPropertyValue(property) {
            // VT_BOOL true is -1; any non-zero short reads as true.
            Ok(v) if v.vt() == VT_BOOL => v.Anonymous.Anonymous.Anonymous.boolVal.0 != 0,
            // Not a boolean (a property the element does not support comes back
            // as a placeholder object): not available.
            Ok(_) => false,
            Err(_) => false,
        }
    }
}

fn clip_empty(r: windows::Win32::Foundation::RECT) -> Rect {
    if r.right < r.left || r.bottom < r.top {
        return Rect {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        };
    }
    Rect {
        x: r.left,
        y: r.top,
        width: r.right - r.left,
        height: r.bottom - r.top,
    }
}

/// The runtime id of a cached element, from the safe array it arrives in.
pub fn runtime_id_of(el: &IUIAutomationElement) -> Vec<i32> {
    unsafe {
        let Ok(variant) = el.GetCachedPropertyValue(UIA_RuntimeIdPropertyId) else {
            return Vec::new();
        };
        // An unsupported property is a placeholder object, not an array.
        if variant.vt() != VARENUM(VT_ARRAY.0 | VT_I4.0) {
            return Vec::new();
        }
        let array: *mut SAFEARRAY = variant.Anonymous.Anonymous.Anonymous.parray;
        read_ints(array)
    }
}

/// Copies a one-dimensional array of 32-bit integers. The array stays owned by
/// the VARIANT it came in, which frees it when dropped.
unsafe fn read_ints(array: *mut SAFEARRAY) -> Vec<i32> {
    if array.is_null() {
        return Vec::new();
    }
    let mut out = Vec::new();
    unsafe {
        let count = (*array).rgsabound[0].cElements as usize;
        let mut data: *mut std::ffi::c_void = std::ptr::null_mut();
        if SafeArrayAccessData(array, &mut data).is_ok() && !data.is_null() {
            out.extend_from_slice(std::slice::from_raw_parts(data as *const i32, count));
            let _ = SafeArrayUnaccessData(array);
        }
    }
    out
}

impl Source for UiaSource<'_> {
    type Handle = El;

    fn node(&self, h: &El) -> RawNode {
        let el = &h.0;
        unsafe {
            let role = el
                .CachedControlType()
                .map(|t| control_type_name(t.0))
                .unwrap_or("Custom");
            let mut node = RawNode::plain(
                role,
                &el.CachedName().map(|n| n.to_string()).unwrap_or_default(),
            );
            node.automation_id = el
                .CachedAutomationId()
                .map(|n| n.to_string())
                .unwrap_or_default();
            node.class_name = el
                .CachedClassName()
                .map(|n| n.to_string())
                .unwrap_or_default();
            node.bounds = el
                .CachedBoundingRectangle()
                .map(clip_empty)
                .unwrap_or(node.bounds);
            node.enabled = el.CachedIsEnabled().map(|b| b.as_bool()).unwrap_or(true);
            node.offscreen = el.CachedIsOffscreen().map(|b| b.as_bool()).unwrap_or(false);
            node.focused = el
                .CachedHasKeyboardFocus()
                .map(|b| b.as_bool())
                .unwrap_or(false);
            node.runtime_id = runtime_id_of(el);

            if available(el, UIA_IsInvokePatternAvailablePropertyId) {
                node.actions.push(Action::Invoke);
            }
            if available(el, UIA_IsValuePatternAvailablePropertyId) {
                node.actions.push(Action::Value);
                let password = el.CachedIsPassword().map(|b| b.as_bool()).unwrap_or(false);
                if !password {
                    if let Ok(p) =
                        el.GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    {
                        node.value =
                            Some(p.CachedValue().map(|v| v.to_string()).unwrap_or_default());
                    }
                }
            }
            if available(el, UIA_IsTogglePatternAvailablePropertyId) {
                node.actions.push(Action::Toggle);
                if let Ok(p) =
                    el.GetCachedPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                {
                    if let Ok(state) = p.CachedToggleState() {
                        node.toggle = Some(if state == ToggleState_On {
                            ToggleState::On
                        } else if state == ToggleState_Off {
                            ToggleState::Off
                        } else {
                            ToggleState::Mixed
                        });
                    }
                }
            }
            if available(el, UIA_IsExpandCollapsePatternAvailablePropertyId) {
                node.actions.push(Action::ExpandCollapse);
                if let Ok(p) = el.GetCachedPatternAs::<IUIAutomationExpandCollapsePattern>(
                    UIA_ExpandCollapsePatternId,
                ) {
                    if let Ok(state) = p.CachedExpandCollapseState() {
                        node.expand = Some(if state == ExpandCollapseState_Expanded {
                            ExpandState::Expanded
                        } else if state == ExpandCollapseState_Collapsed {
                            ExpandState::Collapsed
                        } else if state == ExpandCollapseState_PartiallyExpanded {
                            ExpandState::Partial
                        } else {
                            ExpandState::Leaf
                        });
                    }
                }
            }
            if available(el, UIA_IsSelectionItemPatternAvailablePropertyId) {
                node.actions.push(Action::SelectionItem);
                if let Ok(p) = el.GetCachedPatternAs::<IUIAutomationSelectionItemPattern>(
                    UIA_SelectionItemPatternId,
                ) {
                    if let Ok(selected) = p.CachedIsSelected() {
                        node.selected = Some(selected.as_bool());
                    }
                }
            }
            if available(el, UIA_IsScrollPatternAvailablePropertyId) {
                node.actions.push(Action::Scroll);
            }
        }
        node
    }

    fn children(&self, h: &El) -> Option<Vec<El>> {
        unsafe {
            // An element read without its children cached answers an error: it has no listable children.
            let kids = h.0.GetCachedChildren().ok()?;
            let n = kids.Length().ok()?;
            Some(
                (0..n)
                    .filter_map(|i| kids.GetElement(i).ok().map(El))
                    .collect(),
            )
        }
    }

    fn refresh(&self, h: &El) -> El {
        unsafe {
            h.0.BuildUpdatedCache(&self.uia.children)
                .map(El)
                .unwrap_or_else(|_| h.clone())
        }
    }
}

// --- watching a window ------------------------------------------------------

#[implement(IUIAutomationStructureChangedEventHandler)]
struct StructureHandler {
    hub: Arc<Hub>,
    hwnd: u64,
    pid: u32,
}

impl IUIAutomationStructureChangedEventHandler_Impl for StructureHandler_Impl {
    fn HandleStructureChangedEvent(
        &self,
        _sender: Ref<'_, IUIAutomationElement>,
        _changetype: StructureChangeType,
        _runtimeid: *const SAFEARRAY,
    ) -> windows::core::Result<()> {
        self.hub.push(
            Origin::Accessibility,
            Kind::Structure,
            self.hwnd,
            self.hwnd,
            self.pid,
            false,
        );
        Ok(())
    }
}

#[implement(IUIAutomationPropertyChangedEventHandler)]
struct PropertyHandler {
    hub: Arc<Hub>,
    hwnd: u64,
    pid: u32,
}

impl IUIAutomationPropertyChangedEventHandler_Impl for PropertyHandler_Impl {
    fn HandlePropertyChangedEvent(
        &self,
        _sender: Ref<'_, IUIAutomationElement>,
        _propertyid: UIA_PROPERTY_ID,
        _newvalue: &VARIANT,
    ) -> windows::core::Result<()> {
        self.hub.push(
            Origin::Accessibility,
            Kind::Property,
            self.hwnd,
            self.hwnd,
            self.pid,
            false,
        );
        Ok(())
    }
}

/// What a watched window holds so the watch can be taken down.
pub struct Subscription {
    element: IUIAutomationElement,
    structure: IUIAutomationStructureChangedEventHandler,
    property: IUIAutomationPropertyChangedEventHandler,
}
// SAFETY: as for `El`.
unsafe impl Send for Subscription {}
unsafe impl Sync for Subscription {}

/// The properties whose change counts as the window changing.
const WATCHED: [UIA_PROPERTY_ID; 7] = [
    UIA_NamePropertyId,
    UIA_IsEnabledPropertyId,
    UIA_IsOffscreenPropertyId,
    UIA_ToggleToggleStatePropertyId,
    UIA_ExpandCollapseExpandCollapseStatePropertyId,
    UIA_ValueValuePropertyId,
    UIA_SelectionItemIsSelectedPropertyId,
];

impl Uia {
    /// Starts counting structure and property changes under `window`.
    pub fn watch(
        &self,
        window: windows::Win32::Foundation::HWND,
        hub: &Arc<Hub>,
        hwnd: u64,
        pid: u32,
    ) -> windows::core::Result<Subscription> {
        unsafe {
            let element = self.automation.ElementFromHandle(window)?;
            let structure: IUIAutomationStructureChangedEventHandler = StructureHandler {
                hub: Arc::clone(hub),
                hwnd,
                pid,
            }
            .into();
            let property: IUIAutomationPropertyChangedEventHandler = PropertyHandler {
                hub: Arc::clone(hub),
                hwnd,
                pid,
            }
            .into();
            self.automation.AddStructureChangedEventHandler(
                &element,
                TreeScope_Subtree,
                None::<&IUIAutomationCacheRequest>,
                &structure,
            )?;
            if let Err(e) = self.automation.AddPropertyChangedEventHandlerNativeArray(
                &element,
                TreeScope_Subtree,
                None::<&IUIAutomationCacheRequest>,
                &property,
                &WATCHED,
            ) {
                let _ = self
                    .automation
                    .RemoveStructureChangedEventHandler(&element, &structure);
                return Err(e);
            }
            Ok(Subscription {
                element,
                structure,
                property,
            })
        }
    }

    /// Takes a watch down. Failures are ignored: the window may be gone already.
    pub fn unwatch(&self, s: &Subscription) {
        unsafe {
            let _ = self
                .automation
                .RemoveStructureChangedEventHandler(&s.element, &s.structure);
            let _ = self
                .automation
                .RemovePropertyChangedEventHandler(&s.element, &s.property);
        }
    }
}
