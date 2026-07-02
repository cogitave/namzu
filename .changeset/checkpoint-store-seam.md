---
'@namzu/sdk': minor
---

Pluggable checkpoint persistence with cadence and growth controls.

Iteration checkpoints now flow through a new `CheckpointStore` interface
(`types/run/checkpoint-store.ts`) keyed by the full run scope
(`tenantId`/`projectId`/`sessionId`/`runId`) instead of a filesystem
path, so hosts can persist mid-turn resume state in a shared backend
(e.g. Postgres) that survives machine loss:

- `QueryParams.checkpointStore?` injects a store per run (mirrors the
  existing `pathBuilder?` override); the disk layout under the run's
  output directory remains the default via the new exported
  `DiskCheckpointStore` conformance adapter over `RunDiskStore`.
- `RunPersistenceConfig.checkpointStore?` +
  `RunPersistence.getCheckpointStore()`/`getRunScope()` expose the same
  seam to embedded callers.
- The replay entry points (`listCheckpoints`, `prepareReplayState`)
  accept an optional `checkpointStore` + `scope` pair; their
  disk-addressed `baseDir` inputs are unchanged.
- `CheckpointManager` now takes `(store: CheckpointStore, scope:
  CheckpointRunScope)` — a breaking constructor change for direct
  constructions; the query pipeline threads it automatically.

Growth control on the run config, byte-identical by default:

- `AgentRunConfig.checkpointEvery?` (default 1 = every tool-call
  iteration, today's behavior) checkpoints iterations 1, 1+N, 1+2N, …
  and skips the HITL `iteration_checkpoint` park on off-cadence
  iterations.
- `AgentRunConfig.pruneKeepLast?` (default undefined = never prune)
  prunes the run's checkpoint set down to the newest N after each
  iteration-checkpoint create.
