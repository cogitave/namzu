---
type: Reference
title: Durable resident learning records
description: SQLite experiment authority, immutable JSON artifacts, scoped inspection and explicit host execution.
resource: packages/sdk/src/manager/resident/learning-store.ts
tags: [sdk, agents, learning, sqlite, storage]
status: draft
---

# Durable resident learning records

`SqliteResidentLearningStore` retains the [learning cycle](resident-learning-cycle.md)
without introducing another model executor. `runStoredResidentLearningCycle`
supplies its durable event callback and saves the full verification and confirmation
batches. The caller still owns generation, independent evaluation, authorization,
execution limits and the agenda. Both APIs are experimental and opt-in.

[Learning discovery](resident-learning-discovery.md) adds host-scored observations
and per-task attempt claims in the same database. A host can let the SDK select
an eligible retained failure through `runStoredResidentLearningFromObservations`.
Both host paths require a predeclared `protection` plan under the
[learning-cycle contract](resident-learning-cycle.md). The `started` event
retains its exact selection before generation; evaluation artifacts retain the
actual paired control trials. Reopening a historical cycle does not add controls
or qualify its candidate under the new gate.

## Authority and layout

| Record | Authority | Recovery meaning |
| --- | --- | --- |
| Cycle identity, declared parent, ordered events, receipt totals and final result | SQLite | The summary and event commit together; list queries do not scan artifacts. |
| Complete evaluation batches and optional host traces | Immutable JSON files, referenced by SHA-256 from SQLite | Verify size and digest before using their content. |
| Accepted skill, its evidence and agenda revision | Existing resident agenda | This is the activation authority, even if the final experiment event is missing. |
| Provider run and tool transcripts | Existing host RunStore | A learning receipt references execution; it does not replace its original transcript. |

The CLI uses one `state/learning.sqlite` per application home and
`learning/artifacts/<sha256>.json` for complete content. SQL ownership includes
installation tenant, Project and resident key. A parent cycle must already exist
in that same scope. There is no folder or JSON registry per experiment.

The SQLite event journal is authoritative, rather than a disposable index. JSONL
exports can be derived by paging `events`; they are observations, not a second
writable authority or a replay queue. Session storage and the resident agenda
keep their existing boundaries.

## Open and inspect

```ts
import {
  SqliteResidentLearningStore,
  runStoredResidentLearningCycle,
  type ResidentLearningCycleOptions,
  type SqliteResidentLearningStoreOptions,
} from '@namzu/sdk'

async function learn(
  storage: SqliteResidentLearningStoreOptions,
  host: Omit<ResidentLearningCycleOptions, 'record'>,
) {
  const store = new SqliteResidentLearningStore(storage)
  const result = await runStoredResidentLearningCycle(store, host)
  return { result, artifacts: await store.artifacts(result.cycleId) }
}

async function inspect(storage: SqliteResidentLearningStoreOptions) {
  const store = new SqliteResidentLearningStore({ ...storage, readOnly: true })
  const cycles = await store.list({ limit: 20 })
  const first = cycles[0]
  return first ? { cycle: first, events: await store.events(first.cycleId, { limit: 32 }) } : null
}
```

Options require `databasePath`, `artifactsPath`, `scope` and optionally `readOnly`.
The SDK lazily loads native SQLite and requires Node.js 22.13 or newer only when
this store is used. Private parent directories, host access policy and backup
coordination remain caller responsibilities. The CLI applies its existing private
state-directory checks. An unopened/absent database is not silently initialized
by a read-only inspection; the CLI reports no experiments before constructing it.
A writable store is initialized by its first append. Unknown schema versions and
nonempty unversioned databases are refused.

An observation write also initializes the store. Schema version 2 adds observation
and attempt tables; version 1 is upgraded on the next write. Read-only inspection
does not perform that upgrade. Older readers restricted to version 1 cannot read
an upgraded database.

- `append(event)` requires contiguous sequence numbers. Repeating identical
  serialized content at the same number is idempotent; conflicting content,
  a gap or a new event after the terminal event is refused.
- `get(cycleId)` reads one scoped summary. `list({before, limit})` pages newest
  first using stable numeric ordinals; the limit is 1–100, default 20.
- `events(cycleId, {after, limit})` returns ordered events after the exclusive
  sequence cursor; the limit is 1–256, default 100.
- `putArtifact(cycleId, name, value)` requires a recorded cycle. Repeating the
  same name and JSON bytes is idempotent. Changing content under an existing
  name is refused. `artifacts(cycleId)` lists metadata;
  `readArtifact(cycleId, name)` verifies complete bytes before parsing.

Cycles are bounded to 4,096 events and 256 artifacts. An event is at most 256 KiB;
a JSON artifact is at most 8 MiB. Receipt identities are unique within a cycle,
including UUID case aliases, and capped at 1,024. `recordedUsage` exposes tokens,
known cost, receipt count and unknown token/cost counts even before a final result.
These are recorded lower bounds. A finished event must agree with those receipt
totals; an absent receipt or executor acknowledgement is never assumed to cost zero.

## Transactions and interrupted work

Each database operation uses a short transaction, a five-second busy timeout,
rollback journaling and full SQLite synchronization. No transaction crosses an
`await`, a model request, a tool call or artifact publication. This favors a
simple local, explicitly invoked workload; throughput under sustained parallel
learning has not been benchmarked. It is not a claim that rollback journaling
outperforms WAL.

Artifact publication writes and syncs a private candidate file, links its complete
bytes to an immutable hash name, verifies that content and only then records the
reference. Unix directory sync precedes the reference transaction. Windows skips
directory fsync; power-loss durability on Windows has not been established by
the Linux process tests. Interrupted publication may leave an unreferenced blob
or candidate file. No automatic deletion or garbage collection is performed.

`running` means a start was retained; it does not prove an executor still exists.
`activation-pending` means the request was recorded without a terminal receipt.
The agenda and learning database are separate authorities for different facts:
there is no transaction spanning both. Inspect the skill's exact evidence key
(cycle UUID) and content hash before acting on a pending or `activation-unknown`
cycle. The CLI preserves an acknowledged `activated` result with
`auditComplete: false` when the final journal append fails. It does not replay
model calls or activation automatically.

For a simple consistent backup, stop writers and copy the database, artifacts,
resident agenda and referenced run evidence together. Do not copy only a live
SQLite main file or restore an artifact directory as though it were the complete
journal. A missing or corrupted blob produces an explicit read failure.

The [source comparison and tool experiment](../../research/resident/learning-storage.md)
records why these boundaries were chosen and the limits of the current evidence.
