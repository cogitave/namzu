---
'@namzu/sdk': minor
---

Add `ToolManager.prepareExecutionAsync(name, rawInput, signal?)` and use it for
direct, nested and structured tool calls. Asynchronous refinements and JSON-safe
transforms now prepare one normalized input for authorization, review and
execution. Execution retries reuse that input; actual rewrites are revalidated.
The existing synchronous preparation API remains unchanged.

Cancellation ends preparation without admitting a late result. Schema callbacks
remain trusted host code: keep external work free of effects or cooperative with
host cancellation. Non-JSON host inputs must not be mutated while preparation is
pending.

Observation deduplication no longer replays historical schema callbacks. It uses
current executor evidence tied to the actual successful call and exact result.
Historical or recovered results without this proof remain full, so a new turn or
resume may retain more context under the existing compaction limits.
