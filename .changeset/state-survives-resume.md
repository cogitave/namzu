---
'@namzu/sdk': minor
---

Compaction's working state now rides the checkpoint, so a resumed run stops
deleting its own history.

Compaction replaces older messages with a summary and drops any prior
`[COMPACTED CONTEXT]` block, on the grounds that `serializeState` is
cumulative so the newer summary supersedes it. That holds inside one
process. Across a resume it did not: `WorkingStateManager` was constructed
fresh on every `query()` with no restore path, so the second compaction of
a resumed run produced a summary covering only post-resume activity — and
deleted the block that held everything before it.

The restore path deliberately carries that block forward, calling it the
only surviving record of the history the first pass deleted. The next pass
then destroyed it. This is what made the two halves agree.

- `IterationCheckpoint.workingState` — optional, so checkpoints written
  before this field exists restore exactly as they do today.
- `snapshotWorkingState` / `restoreWorkingState` handle the wire shape.
  `WorkingState.files` is a `Map`, which JSON renders as `{}`, so a naive
  snapshot would have silently lost every tracked file. Eviction counters
  round-trip too: a resumed summary that forgot what it had already dropped
  would claim a completeness it does not have.
- State is restored directly rather than by replaying extractors over the
  restored messages — the messages the first pass compacted away are gone,
  so re-extraction is both lossy and non-idempotent.
