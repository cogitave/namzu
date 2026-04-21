---
'@namzu/sdk': minor
---

Replay primitive v1 — fork an existing run from any stored checkpoint with optional mutation at the fork point (ses_005-deterministic-replay).

New public runtime values:

- **`prepareReplayState({ baseDir, runId, fromCheckpoint, mutate?, emergencyDir? })`** — pure-read helper that resolves `fromCheckpoint` (`CheckpointId | 'latest' | 'emergency'`), applies mutations, and returns `{ messages, sourceCheckpoint, attribution }` ready to thread into a `query(...)` call.
- **`listCheckpoints({ baseDir, runId })`** — lists a run's checkpoints as lightweight `CheckpointListEntry` projections.
- **`projectEmergencyToCheckpoint(dump)`** — project an `EmergencySaveData` snapshot to an `IterationCheckpoint` shape with deterministic `cp_emergency_*` id.
- **`MutationNotApplicableError`** — thrown by `prepareReplayState` when a mutation targets a tool call that is not pending at the fork point; carries `availableToolCallIds` for recovery.

New public types:

- **`Mutation`** — discriminated union; single `injectToolResponse` variant in v1.
- **`CheckpointListEntry`** — listing projection distinct from the pre-existing HITL `CheckpointSummary`.
- **`ReplayAttribution`** — `{ sourceRunId, fromCheckpointId, mutations, replayedAt }` record.
- **`Run.replayOf?: ReplayAttribution`** — optional attribution field; `undefined` on original runs.

Scope and non-scope — v1 ships **forked execution from a captured checkpoint, not byte-for-byte reproduction**. Past the fork point, provider calls and tool calls execute live. Deterministic reproduce mode is deferred to a follow-up session.

A single-call `replay({ runId, opts })` wrapper is intentionally not shipped in v1. Composing `listCheckpoints → prepareReplayState → caller-owned query()` is the v1 flow; the wrapper requires a `ReplayEnvironment` design (provider, tools, resume handler, session scope) that lands in a follow-up session.

See `docs/sdk/runtime/replay.md` for the full primitive docs, determinism envelope, and non-scope.
