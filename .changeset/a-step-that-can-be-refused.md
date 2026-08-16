---
'@namzu/sdk': minor
---

New `beforeStep` hook on `query()`/`drainQuery()` and `ReactiveAgentConfig`, plus the `StepVeto` type and a `step_refused` stop reason. Returning `{ reason }` stops the run before the next provider call is made.

Nothing could refuse a step. `prepareStep` only reshapes one — `activeTools`, `model`, `system`, `temperature` — and cannot reject. `StopCondition` reads `steps`, so it fires after the step it disliked has already run and been paid for. The only remaining path was a durable checkpoint built for human review of tool calls, which pauses the run and waits for a person. None of those is what a host with a live rate limit, a revoked tenant or a spend ceiling has: they need the call not to happen.

**A throw fails closed**, deliberately opposite to `prepareStep` beside it. They are different kinds of hook. A broken step-*shaper* skipped costs a run its per-step tuning and lets nothing unsafe through; a broken step-*refuser* skipped is a refusal that did not happen, which is the thing it exists to prevent. The thrown message becomes the recorded reason.

`StepVeto` is an object rather than a boolean because a bare boolean does not say which polarity means stop, and carries nothing into the run record — leaving an operator with a run that ended and no account of why.
