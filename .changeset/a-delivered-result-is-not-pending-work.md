---
'@namzu/sdk': patch
---

A background task whose completion arrived early no longer holds the run open forever

`CompletionInbox.drain()` handed the completion over and marked it claimed, but
left the task on the OUTSTANDING set. That set is meant to hold ids that are
still running, and only the gateway's completion listener takes an id off it —
so if the listener ran BEFORE the launching call said `expect()`, the id was
added to a set nothing would ever clear.

That order is reachable rather than theoretical: `expect()` runs one microtask
after `gateway.createTask()` resolves, and a worker that finishes fast is
announced in between. The result of it was `hasPendingWork === true` for the
rest of the run, with an empty inbox — so every attempt to settle waited out the
full background grace period for a result that was already in the transcript,
and did it again on the next turn, and the next.

Nothing to do on upgrade. If you were seeing runs pause for two minutes before
their final answer with no background work outstanding, this was why.
