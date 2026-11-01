---
'@namzu/sdk': patch
---

A tool-result guardrail's `halt` verdict now ends the turn instead of reaching the model as an ordinary failed tool result.

`ToolExecutor` caught every exception from a tool call and turned it into a failed result, including the `ToolResultHalted` that a `halt` verdict throws. The model then read it as a rejected call and tried another way, which is what `refuse` means and `halt` must not. The executor now lets `ToolResultHalted` through, so the turn stops with `stopReason: 'error'` and the model is not asked again.

This only affects hosts that configure a guardrail returning `{ action: 'halt' }`. Nothing to change unless you relied on a `halt` being retried; return `{ action: 'refuse' }` to keep that behaviour.
