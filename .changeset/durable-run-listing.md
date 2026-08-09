---
"@namzu/sdk": minor
---

You can now ask the checkpoint store which runs are waiting on a human, or
which parks nobody answered in time, without already knowing their run ids.

`CheckpointStore.listDurableRuns(scope, options)` lists every run with
durable checkpoint state under a **contiguous prefix** of tenant → project →
session, filtered by park state (`outstanding` / `expired` / `resolved`),
paged with `limit` and `cursor`. Reach it through the exported
`listDurableRuns(store, scope, options)` helper. An approval inbox is one
call with `{ park: ['outstanding'] }`; the reclamation sweep that
`hitlParkTtlMs` documents is the same call with `['expired']`.

**Nothing you have implemented breaks.** The method is optional on the
interface, so an existing custom `CheckpointStore` still satisfies it. If
you call the listing against a store that does not implement it, you get a
`capability_unavailable` error rather than an empty page — an empty page
would read as "no runs are parked" when the truth is "this store cannot
tell", and an inbox built on that answer never fires.

Also new:

- `InMemoryCheckpointStore`, exported. It is the reference for writing an
  attribution-keyed backend, and unlike the disk store it holds more than
  one tenant.
- `DiskCheckpointStore` takes an optional second constructor argument
  carrying `tenantId`, `projectId` and `sessionId`. The disk layout records
  none of them, so a store built without it can persist checkpoints and
  refuses to list them rather than stamping rows with a guessed tenant. The
  kernel's own default store passes them, so runs started through `query()`
  are listable with no change on your side.
- New types: `CheckpointListingScope`, `DurableRunEntry`, `DurableRunPage`,
  `ListDurableRunsOptions`, `ParkState`, `ParkSummary`,
  `DiskCheckpointStoreAttribution`.
- The three helpers a backend of your own actually calls, so it inherits the
  park precedence, the ordering and the scope refusal instead of re-deriving
  them: `toDurableRunEntry`, `paginateDurableRuns`,
  `assertContiguousListingScope`.

Two behaviours to know before you build on the listing. Rows are ordered by
`runId`, not by time: a cursor must sort on a key that cannot move, and
every timestamp derivable from checkpoints moves. And a row carries no run
status, because a checkpoint is written mid-flight and this store genuinely
cannot tell a run that finished from one that died — a crash sweep lists
every run with durable state and intersects it with your own records.

Deprecated: `RunDiskStore.listRuns`. It still works and is removed in the
next major. Its entries carry no tenant, project or session, so a row cannot
be turned back into an addressable scope; its writer skips every sub-run, so
an inbox built on it drops every approval raised by delegated work; and it
catalogues runs that started rather than runs with resumable state. Move to
`listDurableRuns`, which answers all three.

One behaviour change inside the disk store: a checkpoint file that vanishes
between the directory listing and its read now throws instead of returning
an empty array. The old shape discarded every checkpoint it had already
parsed and reported the run as having none, which for a parked run reads as
"no approval is pending".
