---
'@namzu/sdk': minor
---

A host can judge the **answer**, and one agent instance runs one thing at a
time.

**`reviewAnswer` closes the verify-then-fix loop.** `stopWhen` is evaluated
after each step's *tools* have run, so it had nothing to say at the moment
the model stopped calling them — the run finalized with whatever it had
produced. Running the build, feeding the failure back, and letting the
model try again meant starting a whole new run and re-supplying the context
the first one had already assembled.

The reviewer sees the answer and the history, and either accepts or returns
feedback that becomes the next user turn. Three properties carry it:

- **Bounded** by `maxAnswerReviews` (default 3), stopping with
  `stopReason: 'answer_rejected'`. The distinct reason matters: without it
  a reviewer that never accepts ends the run on `max_iterations`, naming
  the resource it exhausted rather than the judgement that exhausted it,
  and the reader goes looking for a loop instead of at the reviewer.
- **Never on the forced-final turn**, which exists to extract a closing
  summary under pressure. Rejecting it would spend budget the run has
  already run out of.
- **A reviewer that throws ACCEPTS** — the opposite of the safety gates,
  deliberately. Those are asked "is this dangerous", where failing closed
  costs one refused operation; this is asked "is this good enough", where
  failing closed hands the answer back forever and turns every run into a
  loop. One unreviewed answer is the cheaper failure, and the throw is
  logged at `error` so it is never mistaken for approval.

Shaped after the structured-output re-prompt directly above it in the loop,
which solves the same problem for one specific judge.

**The invocation lock now has a caller.** `InvocationLock`,
`ConcurrentInvocationError` and `acquireInvocationLock` were all defined and
exported, and no agent ever acquired the lock — so concurrent invocations of
one instance were not prevented and the error type could not be thrown by
anything.

They are genuinely unsafe: `abortController` and `currentRunId` are
*instance* state. Two overlapping runs share one abort controller, so
cancelling either kills both, and the second clobbers the first's run id, so
a later `cancel()` cancels the wrong run. Neither failure announces itself —
the first run simply stops, or the wrong one does. A host that wants
parallelism constructs a second instance, which is cheap; sharing one was
never the supported shape, it merely was not refused.

This is the other half of `ConcurrencyMode`, removed earlier in this release
as an unreachable type promising a `queue` mode that was never built.
