---
"@namzu/sdk": minor
---

`turnConfig.sandbox.acquire` chooses when a turn acquires its sandbox: `'eager'` (the default, and what every sandboxed turn did before), `'concurrent'`, or `'on-first-use'`. With `'concurrent'` the first model request no longer waits for the provider to allocate; the first tool batch does, bounded by the turn timeout and cancelled by the abort signal. With `'on-first-use'` nothing is allocated until a tool call needs it. A failed or timed-out acquisition ends the turn with the stop reason an eager one gives, at the first tool call or at turn end, and `sandbox_created` is emitted when the handle arrives, so with `'concurrent'` it can follow the start of the first model response. Nothing changes unless you set the option.
