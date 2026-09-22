---
"@namzu/sdk": major
---

Checkpoint retention is part of every checkpoint store, and a failed prune no
longer ends a turn.

- `SessionCheckpointStore.prune(scope, keepLast)` is **required**. It deletes
  a turn's oldest committed checkpoints until `keepLast` newer ones remain and
  returns the deleted ids, which the kernel records as `checkpoint_pruned`. It
  never deletes a checkpoint an open decision references, and it counts and
  deletes only checkpoints a `checkpoint_written` record commits. A custom
  store implements it; the optional `pruneCheckpoints` it replaces is gone.
  `selectSessionCheckpointsToPrune` is the selection the built-in stores use.
- A prune that throws after an iteration's checkpoint is logged
  (`Checkpoint retention failed; older checkpoints are kept for now`) and the
  turn continues. Before, the error failed the live turn.
- Listing parked work no longer reads checkpoints at all:
  `SessionIndex.listPendingDecisions` and `listTurns` answer from the index.
