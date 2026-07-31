---
'@namzu/sdk': patch
---

Answer every `tool_use` block, and stop a human approval from overriding a gate denial.

Four tool-review paths — verification-gate all-deny, human `reject_tools`,
`modify_tools` with everything denied, and `modify_tools` with a *partial*
deny — returned without producing a `tool_result` for the calls they refused.
The assistant turn stayed unanswered, so the next provider request was
malformed (`400 … Did not find 1 tool_result block(s)`) and the run died.
Any host wiring a rejection decision (including the `namzu` TUI's permission
prompt) hit this on the first decline.

`ToolExecutor.executeBatch` now takes an optional denial map and answers
*every* call in the batch: refused calls get a synthetic error `tool_result`
carrying the reason instead of being executed. Because there is one place
that turns tool calls into messages, the invariant now holds by construction.
The refusal reason travels inside the `tool_result` rather than as a trailing
`[SYSTEM]` user message, so a rejection steers the model instead of only
stopping it.

Alongside it, a policy-bypass fix: on the gate's *mixed*-decision path a human
`approve_tools` replayed the full, unfiltered response and executed the calls
the gate had denied. Gate denials are now threaded through every downstream
execution, and a `modify_tools` rewrite can no longer resurrect a denied call.

Checkpoint resume repairs unanswered tool calls (`removeDanglingMessages`)
before replaying history, so a run parked at a tool-review checkpoint and
resumed in a fresh process no longer fails on its first model call.
