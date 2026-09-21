---
"@namzu/sdk": minor
---

Checkpoint retention no longer ends a run, and no longer re-reads the whole
history every iteration.

- A prune that throws after an iteration's checkpoint is logged
  (`Checkpoint retention failed; older checkpoints are kept for now`) and the
  run continues. Before, the error propagated and failed the live run.
- New optional `CheckpointStore.pruneCheckpoints(scope, keepLast)`.
  `CheckpointManager.prune` calls it when a store has it and falls back to
  list-and-delete otherwise, with the same outcome. `DiskCheckpointStore`
  implements it by reading the checkpoint files alone, so one damaged history
  does not stop retention, and it collects the history the deleted
  checkpoints held. Existing stores need no change.
- `DiskCheckpointStore.listDurableRuns` reads checkpoint headers only.
- `toDurableRunEntry` accepts checkpoints without their messages.
