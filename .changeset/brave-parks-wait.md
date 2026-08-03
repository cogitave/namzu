---
'@namzu/sdk': minor
---

Durable run state: a parked approval now survives a process boundary.

A HITL park used to exist only as a suspended `await` inside one process.
The checkpoint written just before it looked identical to any mid-run
checkpoint, so nothing in durable state said a human owed the run an
answer — an approval queue could not be rebuilt, and a serverless host
could not park a run at all, because the container holding the promise had
to stay alive.

- `IterationCheckpoint.pending` records the `HITLDecisionRequest` verbatim,
  plus the answer once it arrives (kept as evidence, not erased).
- `findPendingCheckpoint(store, scope)` — the read an approval queue is
  built from, in any process.
- `RunState` + `captureRunState` / `loadRunState` / `parseRunState`: a
  flat, JSON-safe snapshot with a version guard, so a snapshot written by
  one deployment cannot silently half-restore in another.
- `QueryParams.pendingDecision` applies a decision collected out-of-band to
  the exact tool calls the human was shown. Without it a resumed run
  repaired the unanswered `tool_use` blocks away and let the model
  re-decide, so "yes, delete that row" degraded into "ask the model again
  and hope it asks for the same thing". The decision is ignored (and the
  repair path runs) when the checkpoint's calls no longer match the
  recorded request — consent to one batch is not consent to another.
- A `pause` decision keeps the park outstanding; every other action
  resolves it. A host that cannot block answers `pause` immediately and
  comes back in another process.
- Park recording is lazy (`parkRecordDelayMs`, default 250ms) so a
  programmatic handler never pays for it — except `pause`, which is always
  recorded because it means the decision is still owed.
