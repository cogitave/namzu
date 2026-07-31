---
'@namzu/sdk': patch
---

Carry budgets across a checkpoint resume, and count the side-channel model calls.

Budget enforcement was neither durable nor total.

**Durable.** `IterationCheckpoint` faithfully persisted `tokenUsage`, `costInfo`
and `guardState`, and the resume path replayed messages only — the numbers were
written and then discarded on the way back in. A run checkpointed at $4.80 of a
$5 cap came back with a brand-new $5 and a brand-new timeout clock, so a task
that parked five times spent 5x its cap while every invocation truthfully
reported itself in budget. `RunPersistence.restoreUsage()` and
`GuardCoordinator.restoreElapsed()` (also available as `elapsedMsOffset` at
construction) seed both from the checkpoint before the first iteration, so a
resumed run that is already over budget stops immediately.

**Total.** Three `chatStream` call sites bypassed `accumulateUsage` entirely, so
a run with `tokenBudget: 200_000` could send well past 200k and never trip
`token_budget`:

- the advisory phase — its usage was already captured for reporting and simply
  never reached the accountant;
- the compaction verifier — the worst offender, since it fires exactly when the
  context is largest. It now takes an optional `UsageSink`;
- `RouterAgent` — routing runs before any `RunPersistence` exists, so
  `RoutingDecision` now carries the routing call's `usage` (summed across
  retries) and the router folds it into the result instead of reporting the
  delegate's usage alone.
