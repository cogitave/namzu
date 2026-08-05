---
'@namzu/sdk': minor
---

A run holding for a background worker waits a share of its own budget, not a fixed two minutes

`BACKGROUND_TASK_GRACE_MS = 120_000` was unrelated to the run it bounded, and
wrong in both directions at once. Measured: a run configured `timeoutMs: 20_000`
was held open for **120,267 ms** — six times its own budget — because the hold
sits inside an iteration and the run guard only checks between them, so nothing
could interrupt it. In the other direction, on a run with hours left the same
two minutes abandoned delegated workers observed at 4m21s, 5m58s and 8m04s, all
comfortably inside the hour `DELEGATION_TIMEOUT_MS` already declares.

The hold is now `min(remainingBeforeFinalize × 0.5, DELEGATION_TIMEOUT_MS)`,
where `remainingBeforeFinalize` is the time left before the run guard stops
asking for more work and asks for a closing summary (90% of `timeoutMs`), less
what the run has spent — carried across a resume, so a checkpointed run sizes
the hold from what is left of the RUN rather than of the process now hosting
it, and read when the wait starts rather than at the top of the iteration.

- **Half, not all.** The hold exists to put a worker's result where the model
  can read it, and reading it costs a turn. Spending everything remaining would
  deliver a notification into a run with no turn left to act on it — the same
  failure the mechanism exists to prevent.
- **Bounded against the boundary that binds.** Measuring to the DEADLINE was
  the first attempt and it looked safe: a hold cannot outlive the deadline
  either way. But half of the time-to-deadline, started just under the warning
  threshold, ends at 95% of the budget — so the slice the guard keeps for the
  run to produce a closing answer is half spent waiting for the result that
  answer was supposed to use. Against the finalize point the hold cannot reach
  that reserve at all, which is what makes the guard's inability to interrupt
  a hold a non-issue rather than a smaller issue.
- **A floor of zero, deliberately.** A run with no time left before it must
  start finishing has no turn in which to read a notification. Nothing is
  dropped by it: the wait returns before it looks at its timer when a
  completion is already in hand.

**What changes for you.** A run with a short `timeoutMs` finishes when it said
it would instead of overrunning by minutes. A run with a long one keeps its
worker instead of abandoning it. If you were relying on a fixed two-minute
settle regardless of run configuration, set `timeoutMs` to about four and a half minutes to
get the same hold.
