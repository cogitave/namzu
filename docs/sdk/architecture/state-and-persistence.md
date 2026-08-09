---
title: State and Persistence
description: How @namzu/sdk models sessions, stores, checkpoints, tasks, memory, and durable run state.
last_updated: 2026-08-09
status: current
related_packages: ["@namzu/sdk"]
---

# State and Persistence

The SDK's state model is spread across `session/`, `store/`, and parts of `manager/`. The distinction is deliberate: `session/` defines structural rules, `store/` provides persistence implementations, and `manager/` coordinates runtime behavior around both.

## 1. Session Hierarchy

The `session/` folder is not a single data type. It is a grouped subsystem with several submodules:

| Folder | Responsibility |
| --- | --- |
| `hierarchy/` | Core tenant, project, session, and sub-session entities plus status derivation |
| `workspace/` | Workspace references, path building, and workspace backend drivers |
| `handoff/` | Single and broadcast handoff flows plus capacity and version checks |
| `summary/` | Session summary references and summary materialization |
| `intervention/` | Validation for `prevArtifactRef` chains and intervention depth |
| `migration/` | Filesystem and ID-prefix migration helpers |
| `retention/` | Archival policies, archive backends, and tombstone flow |
| `events/` | Session-level event shapes |

This makes `session/` one of the deepest architecture folders in the package.

## 2. Workspace Ownership

`session/workspace/` defines how session-scoped workspaces are represented and created:

- `PathBuilder` and `DefaultPathBuilder` define path conventions.
- `WorkspaceBackendRegistry` resolves workspace backend implementations.
- `GitWorktreeDriver` is the concrete driver for git-worktree-based isolation.

This is an example of a subsystem that keeps its contract and driver in the same domain folder, because both are session-owned concerns.

## 3. Store Layer

`store/` holds concrete persistence implementations:

| Store area | Main implementation examples |
| --- | --- |
| Run storage | `store/run/disk.ts` |
| Task storage | `store/task/memory.ts`, `store/task/disk.ts` |
| Memory storage | `store/memory/index.ts`, `store/memory/memory.ts`, `store/memory/disk.ts` |
| Conversation compatibility | `store/conversation/memory.ts` |
| Activity storage | `store/activity/memory.ts` |

The important pattern is that stores persist or retrieve data, but they do not own broader runtime orchestration.

## 4. Run Persistence

`store/run/disk.ts` and `manager/run/persistence.ts` work together:

- `RunDiskStore` creates per-run directories and writes `run.json`, `messages.json`, `transcript.jsonl`, reports, and checkpoints.
- `RunPersistence` coordinates the runtime-facing state transitions around that disk layer.

The disk layout is intentionally file-oriented and append-friendly rather than database-first.

### Enumerating runs, not just addressing one

Checkpoint persistence goes through `CheckpointStore`, whose four core
accessors each take a full run scope. `listDurableRuns` is the fifth and
optional one, and the only read above the run: given a contiguous prefix of
tenant → project → session it returns every run with durable checkpoint
state, each row carrying its own scope and its park disposition. That is
what an approval inbox and the `hitlParkTtlMs` reclamation sweep are built
from; see [Replay §7](../runtime/replay.md).

`RunDiskStore.listRuns` is the older, narrower answer and is deprecated. It
reads `index.json`, whose entries carry no attribution and whose writer
skips every sub-run, so a row cannot be turned back into something a
sweeper could resume.

### The event log is addressable, and readable back

**New in `@namzu/sdk` 21.0.0.** `RunStore.readEvents({ sinceSeq })` is a
**required** accessor: a store that records a transcript it cannot read back is
write-only evidence, which is the defect the contract exists to fix one level
up. It returns the run's durable events oldest first, above an exclusive
cursor, each carrying the `seq` and `timestamp` the log holds.

`RunPersistence` owns the counter. `init()` seeds it from the log, which is why
a resumed run continues its sequence instead of starting a second one inside
it, and assignment is serialized against the append — emits genuinely
interleave (the task store, the plan manager, a batch of parallel tools all
reach one funnel) and a duplicated sequence is worse than a missing one.

Two file-level details the read-back depends on:

- A line written before events were numbered takes its **1-based position** as
  its sequence, so a legacy transcript keeps its evidence and the emitter
  resumes above it rather than on top of it.
- `initRun` **terminates a torn last line**. A process killed during an append
  leaves a fragment with no newline, and the next append lands on the same line
  — so the fragment and a whole, correct event merge into one unparsable line
  and the reader skips both. Ending the fragment costs the fragment and nothing
  after it.

`readRunEventsIn(runDir)` is the free-function form, for the same reason
`readCheckpointsIn` is one: binding a store to read would create the run
directory.

See [Replay §7](../runtime/replay.md) for the cursor and its verdict.

### Resuming a part-executed tool batch

A batch's results reach the message history only once the **whole** batch
settles, so a hard kill part-way through loses every result that had
already come back — and a resumed run re-executes those calls. For a
`write_file` that is waste; for a payment or an email it is a second one.

Nothing new is recorded to fix this. The executor already awaits a
`tool_completed` per tool, inline, carrying the id, the name, the result
and the error flag, and `transcript.jsonl` already persists it — the record
was durable all along and simply was not read back.
`RunDiskStore.readCompletedTools()` reads it, and the restore path feeds
those results to `executeBatch` so an already-executed call is answered
from the record instead of by running the tool again. The calls that never
completed run for the first time, through the ordinary executor, so every
guard and permission check still applies to them.

The discriminator between "resume this batch" and "let the model
re-decide" is whether the transcript holds any completion for the turn. A
tool-review park records its checkpoint *before* any execution, so it has
none and keeps the cheap repair — re-deciding there costs only a round
trip, and taking the batch over would execute calls a human has not
answered yet. A torn last line, the normal shape of a file that was being
appended to when the process died, is skipped rather than failing the
recovery.

## 5. Task Storage

`DiskTaskStore` is a good example of the SDK's persistence style:

- Paths are derived from `baseDir`, `runId`, and optional `tenantId`.
- Writes are atomic through temp-file-and-rename behavior.
- Related task edges are updated while holding per-task locks.
- Event listeners receive structured task events after mutations.

This is not just a JSON dump helper. It already encodes concurrency and cascade-cleanup rules.

## 6. Memory Storage

The memory subsystem is split between index and content:

| Piece | Responsibility |
| --- | --- |
| `InMemoryMemoryIndex` | Searchable metadata index over memory entries |
| `DiskMemoryStore` | Durable content storage plus persistent index writes |
| `InMemoryMemoryStore` | Simpler in-memory content storage |

This lets search stay cheap while full content remains separately addressable.

## 7. Migration and Compatibility

The SDK still carries some migration-window compatibility surfaces:

- `store/conversation/memory.ts` is explicitly deprecated in favor of newer session-scoped storage.
- `session/migration/` handles filesystem migration and legacy ID acceptance.
- Runtime bootstrap calls migration before building the active run context.

The architecture implication is that compatibility is isolated in dedicated folders instead of leaking into the main runtime path.

## 8. Archival and Retention

`session/retention/` owns the long-tail lifecycle after active execution:

- retention policy types
- archive backends
- archival manager
- archive lookup and tombstone semantics

This keeps "what happens after a session becomes inactive" outside the hot path of the iteration loop.

## Related

- [SDK Architecture](./README.md)
- [Runtime Pipeline](./runtime-pipeline.md)
- [Extensions and Integrations](./extensions.md)
- [Session Barrel](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/session/index.ts)
- [RunDiskStore](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/store/run/disk.ts)
