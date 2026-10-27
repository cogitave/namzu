---
'@namzu/sdk': minor
'@namzu/cli': patch
---

When Namzu was closed while tool calls were waiting for your approval, `/resume` used to show them as "Interrupted" and then stop with "Turn is parked on a decision only a person can answer", and the next message was refused. Now the calls read "Not run", they are not asked about again, `/resume` and your next message close the left-over turn, and the model is told those calls did not run so it asks afresh if it still needs them. Nothing changes if you were never asked.

`repairToolMessageHistory` takes an optional second argument `{ neverRan }`, a set of call ids whose synthetic result says the call did not run instead of that its outcome is unknown. The runtime fills it from the session log for calls that provably never started. Callers that pass nothing see the same output as before.

`leaseHolderProcessIsGone(lease)` is new: true only when the lease was taken by a turn (`namzu:<pid>:...`) whose pid does not exist on this machine. Session-level operations such as `abandonTurn` now take over a session held by such a writer instead of refusing it until the lease expires; a live or unrecognisable holder is still refused.
