---
'@namzu/sdk': minor
---

Every tool call a `run_code` program makes is visible in the run's event stream.

The program's calls went through `registry.execute` directly, so they reached the permission gate and reached the event stream **not at all**. A run whose transcript showed one `run_code` call and nothing about the eleven writes it performed is a transcript nobody can audit — the tool would be the one place in the system where work happens off the record.

`tool_executing` and `tool_completed` gain an optional `via`, present when another *tool* dispatched the call rather than the model. It **names** the dispatching call rather than merely marking this one nested, and that is the load-bearing part: without it a consumer counting tool calls double-counts the parent and each child, and one rendering a timeline draws eleven siblings where there is one call with eleven children. It is carried on both events, so a consumer can pair them without holding the start.

A nested call gets its **own** id. Reusing the parent's would make two different calls indistinguishable in any log keyed by it, which is exactly how a nested write gets attributed to the program that ran it rather than to itself.

`dispatchTool` is bound **per call** rather than once per batch. The base tool context has no `toolUseId` — a caller dispatching outside a batch has no parent to name — and a closure built there reported every nested call as parentless, which is what the tests caught.
