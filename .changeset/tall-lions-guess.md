---
'@namzu/sdk': minor
---

Bound tool execution: per-tool deadlines, real cancellation, and a fan-out cap.

`ToolContext.abortSignal` was produced by the executor and consumed by nothing —
a repo-wide grep found only the two producer sites. A Stop tore down the model
stream and then parked inside `Promise.all` waiting for a tool that had no idea
it should quit, and there was no framework-level deadline at all: `bash`
defaulted to **one hour**, and the MCP stdio transport to forever.

- `ToolDefinition.timeoutMs` and `ToolExecutorConfig.toolTimeoutMs` (default
  120s). On expiry the executor stops waiting and returns a model-visible
  error result, so a slow dependency becomes something the agent can route
  around rather than a turn that never comes back.
- The tool's `context.abortSignal` now really fires — on the deadline and on a
  run abort — so cooperative tools stop working instead of merely being
  detached. `bash` passes it to the child process.
- `bash`'s default timeout drops from 1 hour to 2 minutes. The model can still
  request longer through the tool's own `timeout` argument.
- `ToolExecutorConfig.maxToolConcurrency` (default 8) bounds the parallel
  branch of `executeBatch`, which previously fanned out without limit.
- MCP: `MCPClientConfig.requestTimeoutMs` (default 30s) bounds every JSON-RPC
  round trip; in-flight requests are now rejected when the transport closes or
  errors, not only on an explicit `disconnect()`; and a server-initiated
  request (`sampling/createMessage`, `elicitation/create`, `roots/list`,
  `ping`) gets a `-32601` reply instead of being silently discarded, which
  used to leave the server waiting forever.
