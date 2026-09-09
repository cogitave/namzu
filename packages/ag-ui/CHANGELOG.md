# @namzu/ag-ui

## 0.1.0

### Minor Changes

- ddf13ff: Add the optional `@namzu/ag-ui` package for exposing a trusted Namzu query
  configuration through AG-UI typed events or a Fetch-compatible POST/SSE
  endpoint. Hosts resolve authenticated native scope and explicitly admit
  message history; backend tools, request-owned state updates, custom events,
  authoritative final results, usage, cancellation, and bounded payloads are
  supported with the official AG-UI 0.0.59 client.

  Frontend tool definitions and AG-UI resume requests are rejected with HTTP 422. Native pauses report a custom event and a run error; checkpoint
  resumption and durable thread history remain application responsibilities.

- a34d737: Add AGUIRunUI.setInitialMessages for host-authorized display history reconciliation inside createQuery. A validated, detached MESSAGES_SNAPSHOT reaches the client before native query events, subject to existing event byte and queue limits. This does not change model input or automatically trust browser history. Calls after createQuery returns are refused so active message/tool lifecycles cannot be overwritten. Interrupt resumption remains unsupported.
