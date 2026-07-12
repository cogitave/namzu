---
"@namzu/sdk": minor
---

**A run can now be suspended.** Adds `awaiting_input` — a non-terminal run state for a run that has stopped because it needs a human.

Until now namzu had no way to say this. A run that paused for a review only set a `stopReason`; the runtime then terminalized it anyway, marking it **completed**, firing `run_completed` and resolving a result, while callers mapped anything not completed or cancelled to **failed**. A paused run was persisted as a finished one.

The iteration loop now returns an explicit disposition rather than letting callers infer "finished" from the fact that it returned. A suspended run has no `endedAt`, resolves no result, emits no completion event, and is not mapped to completed or failed. `WireRunStatus` carries `awaiting_input` instead of collapsing it to `running`, and it maps to A2A's `input-required`, which has always meant exactly this.

**Breaking for exhaustive consumers**: `WireRunStatus` gains a variant. Code that switches exhaustively over run statuses must handle `awaiting_input`. The pre-existing domain values `awaiting_hitl` / `awaiting_hitl_resolution` — declared but never set by anything — are replaced by the single `awaiting_input`, because a status that is declared and never set is how this bug was born.

This is the prerequisite for durable pause: a paused run must be a state, not an absence.
