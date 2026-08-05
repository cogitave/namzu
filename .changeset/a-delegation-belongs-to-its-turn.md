---
'@namzu/cli': patch
---

A delegated sub-agent joins its parent's trace, and shows the label it was made to write

Two fixes to the `Agent` tool.

**The child run started its own root trace.** `createTask` was called without
`parentSpan`, so a sub-agent opened a disconnected root and the one structure a
delegation trace exists to record — which turn dispatched which child — was the
part that went missing. Anyone reading a trace saw N unrelated roots where there
was one tree. The kernel already carries the span the whole way (executing
tool → `createTask` → child run → child iterations); only the first hop was
dropped. It now passes the executing tool's span, matching the SDK coordinator.

If no span is in scope the key is omitted rather than sent as `undefined`: a
top-level run with no parent is correct to start its own root, and inventing a
parent would be a different wrong answer.

**`description` was required and never read.** The schema forced the model to
write a short label on every call, and the transcript then rendered a truncated
`JSON.stringify` of the raw arguments instead — so a delegation appeared as
`{"description":"Audit the auth flow","prompt":"Read every fi…` rather than
`Agent(Audit the auth flow)`.

We now **read it** rather than dropping the requirement. The model already
writes a good label, the field costs nothing to keep, and removing it would
leave delegations with no honest one-line summary at all — the fallback would
still be the blob. `description` is consulted **last**, after `command`, `path`,
`file_path`, `pattern` and `query`, so tools that already summarised correctly
are unaffected; it only speaks for tools that were falling through to JSON. Two
SDK coordinator tools whose `description` is likewise a user-facing label pick
up the same improvement.

Note for anyone verifying the trace fix in a terminal: the CLI registers no
telemetry provider by default, so spans are no-ops until `@namzu/telemetry` is
installed and a provider registered. The parenting is correct either way; it
becomes visible when there is an exporter to see it.
