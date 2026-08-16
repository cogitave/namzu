---
'@namzu/sdk': minor
---

A cancellation can now say where it came from. New `CancelCause` (`'user' | 'parent' | 'budget' | 'hook'`), the `RunCancelled` abort reason that carries one, and `cancelCauseOf(reason)` to read it back. `run_completed` and `agent_canceled` carry `cancelCause` when one was recorded.

`stopReason: 'cancelled'` said a run was cancelled and nothing else, and the cases behind it want different responses: an operator pressing cancel is not a defect, while a parent abandoning its children is a fact about the parent and sends a reader looking for a problem the child does not have.

The information was not being discarded — it was never carried. `AbstractAgent.cancel()` aborted with no argument at all, and `AgentManager` aborted a child with the bare string `'canceled'`, which `abortReasonText` suppresses *by name* (its docblock cites that call site, because rendering it would print "was cancelled: canceled"). Both paths reached the run loop indistinguishable.

`AgentManager.cancelAll` defaults to `'parent'`, because that call site *is* a parent abandoning its children. `AbstractAgent.cancel(cause?)` has no default for the opposite reason: its caller could be anyone, and defaulting would attribute every unlabelled cancellation to a person who pressed nothing. An unattributed cancellation reports `undefined`, which is a real answer.

`abortReasonText` suppresses `RunCancelled` too. The cause is machine-readable and must not become prose in the run's error text — that is the noise the function already existed to prevent.
