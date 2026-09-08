---
"@namzu/ag-ui": minor
---

Add AGUIRunUI.setInitialMessages for host-authorized display history reconciliation inside createQuery. A validated, detached MESSAGES_SNAPSHOT reaches the client before native query events, subject to existing event byte and queue limits. This does not change model input or automatically trust browser history. Calls after createQuery returns are refused so active message/tool lifecycles cannot be overwritten. Interrupt resumption remains unsupported.
