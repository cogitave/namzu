---
type: Reference
title: Durable run storage
description: Every file a disk-backed run writes, the one record that holds a run's messages, how checkpoints and the settled snapshot reference it, how it is collected, and where generated state goes by default.
resource: packages/sdk/src/store/run/disk.ts
tags: [sdk, runtime, persistence, checkpoints, storage]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-21T00:00:00Z }
---

# Durable run storage

A run backed by the disk stores writes under one directory per run:
`<root>/projects/<projectId>/sessions/<sessionId>/runs/<runId>/` with the
SDK's `DefaultPathBuilder`, or `<root>/sessions/<sessionId>/runs/<runId>/` with
the CLI's. A delegated child run nests under its parent:
`runs/<parentRunId>/children/<childRunId>/`.

## Where `<root>` is

A host that passes a `pathBuilder` chooses `<root>`. One that passes none gets
`defaultStateRoot()` (`packages/sdk/src/session/workspace/state-root.ts`):

| Where | `<root>` |
|---|---|
| `NAMZU_STATE_DIR` is set | that path, resolved |
| Linux and other Unix | `$XDG_STATE_HOME/namzu`, else `~/.local/state/namzu` |
| macOS | `~/Library/Application Support/namzu/state` |
| Windows | `%LOCALAPPDATA%\namzu\state` |

This applies to `query`, `drainQuery`, `runAgent`, the agents built on them,
and `openTokenBudget`. Before 2026-09-21 the default was
`<workingDirectory>/.namzu`. That put generated state inside whatever
directory the agent was pointed at: repositories gained a `.namzu/`, package
tests left one in the package, and a run started in `$HOME` wrote into
`~/.namzu`, the CLI's application home, as a tree the CLI keeps no record of.
The new root is never the working directory and never `~/.namzu`. Runs from
different directories do not collide, because every path under it is keyed
by Project and `runAgent` derives a Project from the working directory.

Two runs that pass the same explicit `projectId`, `sessionId` and `runId`
from different working directories now share one run directory, where before
each working directory had its own. Pass a `pathBuilder` when two such runs
must stay apart.

A run whose `runStore` is an `InMemoryRunStore` and which names no
`pathBuilder` writes nothing under `<root>`. Its token ledger and its
checkpoints (with their history log) are held in memory by that run store
(`packages/sdk/src/runtime/query/stores-held-in-memory.ts`), so they die with
the process as its evidence does; reusing the same `InMemoryRunStore` instance
lets a later call in the same process resume from them. An explicit
`tokenBudgetStore` still wins, and a `pathBuilder` puts both back on disk
under the root it names. A host that passes its own `checkpointStore` keeps
the disk ledger: it may resume in a fresh process with a fresh run store, and
a checkpoint binds its run to the ledger by reference, so a ledger held by the
old run store would make that resume fail. Such a host passes a
`tokenBudgetStore` beside its checkpoint store to move the ledger too. Before
this, a run with an in-memory run store kept its evidence in memory and wrote
`token-budget.json` and its checkpoints under `defaultStateRoot()`, one tree
per run with no retention.

## What each file is for

One record is authoritative for each concern.

| File | Concern | Written by | Read by | Status |
|---|---|---|---|---|
| `transcript.jsonl` | Every run event, in order, hash-chained (`previousRecord`) | `RunDiskStore.appendEvent` | `readRunEventsIn` (public), `readCompletedTools` and `readToolExecutions` (a resume skips calls that already finished), evidence recall, the CLI's replay, search and export | Authoritative. The chain is what makes it evidence. It holds tool outputs as events, not as a message history. |
| `audit.jsonl` | The audit trail, on its own sequence | `RunDiskStore.appendAuditEvent` | `readAuditEvents` (public); `RunPersistence.init` continues its sequence | Authoritative. |
| `run.json` | Status, counters, metadata | `RunDiskStore.writeRunMeta`, at start and at settle | `RunDiskStore.listChildren`, `RunDiskStore.listRuns`, evidence sources, the CLI's search and inspection | Authoritative. Holds a message count, never messages. |
| `history/messages.<g>.jsonl`, `history/edits.<g>.jsonl` | The run's messages, each stored once | `RunDiskStore.writeCheckpoint` and `writeMessages` | every reader of a checkpoint or of the settled snapshot, through the store | Authoritative for messages. See below. |
| `checkpoints/<checkpointId>.json` | One resume point: counters, budget, compaction state, a park, and a reference to its messages | `RunDiskStore.writeCheckpoint` | resume, human-in-the-loop parks, replay, `listDurableRuns` | Authoritative for the resume point. |
| `messages.json` | The history the run settled with and the event it is valid through, as a reference (`namzu.run-message-snapshot.v2`) | `RunDiskStore.writeMessages`, once, at settle | `RunStore.readMessages` / `readRunMessagesIn` (public), `RunQuery`, the CLI's export and delegated-child view | Derived: a view of the history log. |
| `token-budget.json` | The durable token ledger | `DiskTokenBudgetStore` | budget admission and resume | Authoritative. |
| `report.md` | The run's final answer as text | `RunDiskStore.writeReport`, at settle, when there is one | people | Kept. `run.json` does not carry `result`, so this is the one durable copy of the answer (`a-finished-run-reads-back-complete.test.ts`). A few hundred bytes. |

Conversation history across turns is not a run concern. The CLI keeps it in
its session database (`state/sessions.sqlite`); an SDK host keeps it wherever
its `SessionStore` does. Before 2026-09-12 the CLI also wrote `session.json`,
`messages.jsonl` and `index.json` per session through the disk session store;
it no longer does.

### Removed: the run catalogue

`<runs>/index.json` held one row per top-level run: id, agent, model, status,
times, iterations and tokens. Every field was already in that run's
`run.json`, and the whole file was read and rewritten at every settle. The
kernel no longer writes it (`RunPersistence.persist` no longer calls
`RunStore.addToIndex`). Its one reader, the deprecated
`RunDiskStore.listRuns`, now reads the same rows from each run's `run.json`,
so it keeps working, including for runs written before the change. Nothing
in the kernel or the CLI read the file. `RunStore.addToIndex` and
`RunDiskStore.addToIndex` are deprecated and still work when called directly.

## One stored history

A run takes a checkpoint every iteration (`runConfig.checkpointEvery`,
default 1) and another at every tool review. Until checkpoint schema version 3
each one carried the whole message history inline, so an N-iteration run
wrote the history N times: quadratic in the run's length. On one machine that
came to 19,014 checkpoint files and 6.33 GB, with one run holding 532
checkpoints of about 1.5 MB each, out of 7.0 GB of runtime state in all. When
the run settled, `messages.json` wrote the history once more.

Now each distinct message is appended once to the run's history log in
`<runDir>/history/`, and every record that needs a history stores a reference
to it instead of a copy: each version-3 checkpoint in its `history` field, and
`messages.json` in the v2 snapshot format.

```json
{
  "format": "namzu.run-history.v1",
  "generation": 0,
  "count": 103,
  "sha256": "b1a8…",
  "segments": [[0, 0, 469, 2], [1, 12085, 254, 1], [0, 469, 171335, 100]]
}
```

Each segment is `[log, byte offset, byte length, line count]` in one of the
two logs of generation `generation`, and `sha256` covers every referenced
line in order. A message that extends the history, meaning it is part of the
run of new messages at its end, goes to `messages.<g>.jsonl`, so the history
the run keeps appending to stays one contiguous range. Any other new message
is an edit and goes to `edits.<g>.jsonl`. Edits include the working-memory
slot a pinned fact rewrites every iteration, a compaction's summary, and a
tool result replaced by its placeholder. A reference therefore costs a few
ranges per edit rather than a copy of the conversation.

Readers are unchanged. `readCheckpoint`, `listCheckpoints`, `readMessages`,
`readRunMessagesIn` and every caller above them still receive `messages`.
Every checkpoint a listing returns has message objects of its own, so editing
one checkpoint's history never changes another's.

What is kept from the inline format:

- **Refusal over a partial read.** A missing, truncated or altered log fails
  the digest, and the record is refused with the same strictness as a
  damaged inline one. A resume never continues from a history it cannot
  vouch for.
- **Old records read as they are.** A checkpoint with inline `messages`
  (schema 1 or 2) and a v1 `messages.json` are read exactly as before. Only
  new writes use the log.
- **Newer files are refused by older builds.** A build that predates schema 3
  refuses a version-3 checkpoint instead of reading one with no messages, and
  one that predates the v2 snapshot refuses the new `messages.json` as an
  invalid snapshot. Upgrade every process that resumes or reads a run before
  any of them writes to it.
- **Durability.** Log appends are not fsynced, as the checkpoint files never
  were. A process crash keeps the page cache. A power loss that drops
  appended bytes leaves a record whose digest no longer matches, which is
  refused rather than misread.

### Collecting what nothing references

A line is dead once no record references it: a pin slot rewritten since, a
head a compaction replaced, the history of a checkpoint that retention
pruned. Without collection a run with retention would still keep every
message it ever produced.

After retention deletes checkpoints, `RunDiskStore.pruneCheckpoints` compares
the bytes the remaining records reference, computed from the references
alone, with the bytes stored. When the dead bytes exceed both the live bytes
and 256 KiB, it copies the referenced lines into generation `g + 1` (fsynced),
rewrites each record's reference (the digest is unchanged: the same bytes in
the same order), and only then deletes the older generations. The logs stay
within about twice the history that is still referenced, and the copying
costs a constant per byte written. A record whose history cannot be resolved
stops the collection before anything is written, so damage is never
collected around.

A crash at any step, a process crash or a power loss alike, leaves every
record pointing at a generation that still exists, and the next collection
finishes the job. Nothing is deleted until what replaces it is on stable
storage: the new generation's files are fsynced, then the history directory
that names them; each record is rewritten through `durableWriteFile`
(`packages/sdk/src/utils/atomic-write.ts`), which fsyncs the file and then
its directory; only then are the older generations unlinked. The unlinks are
not synced, so a power loss right after them can bring an old generation
back, which costs space until the next collection and nothing else. On
Windows the directory fsyncs are skipped because the platform refuses them,
and the directory entries rest on NTFS's own metadata journal. A disk or
filesystem that acknowledges an fsync it did not perform defeats all of
this, and nothing here can detect it.

### Concurrency

Every write, every collection and every read that resolves a history runs
under one lock per run directory, shared by every store in the process: the run's own
`RunDiskStore` and the checkpoint store are two instances. A record is
written, log append and the file that references it, inside the lock, so a
collection never sees an append without its reference. Across processes,
appends are single `O_APPEND` writes, and a writer that finds a log at a
length it did not predict rebuilds its index from the file. Collection is not
coordinated across processes. A reader in another process that loses a
generation re-reads the record, which by then points at the new one. Two
processes writing one run at once is a split claim, which the claim fence
refuses.

### Measured

`scripts/benchmarks/runtime-state-growth.mjs` runs a scripted run through the
real disk stores; every iteration calls a tool returning about 4 KB and pins a
fact. "Before" is `main` at `cf271eb9`, measured on the same machine in the
same session.

| Iterations, retention | Files before → after | Bytes before → after | Checkpoint bytes before → after (records + history log) |
|---|---|---|---|
| 50, keep all | 105 → 106 | 11,201,811 → 2,129,528 | 10,206,928 → 1,134,739 + 184,333 |
| 50, keep 10 | — → 18 | — → 1,155,299 | — → 160,483 + 184,333 |
| 200, keep all | 405 → 406 | 113,162,176 → 11,666,088 | 108,807,129 → 6,677,467 + 968,819 |
| 200, keep 10 | — → 18 | — → 4,471,653 | — → 160,780 + 314,523 |

`messages.json` went from 184,657 bytes to 494 at 50 iterations and from
358,953 to 23,973 at 200, where compaction rewrote the head and the reference
carries more ranges. With retention at 10 the history log of the 200-iteration
run is 314,523 bytes against 968,819 without collection. A checkpoint record
is mostly the compaction state it snapshots (`workingState`, about 15 KB
here, bounded by the compaction manager's own caps).

## Bounding how many there are

`runConfig.pruneKeepLast` keeps the newest N checkpoints after each iteration
checkpoint. It never collects one whose park is unresolved
(`selectCheckpointsToPrune`, `packages/sdk/src/store/run/prune.ts`). The
default is `undefined`: every checkpoint is kept. `BaseAgentConfig.pruneKeepLast`
forwards it from `ReactiveAgent` and `SupervisorAgent`, which is how a host
bounds delegated children as well. The CLI sets it for every run it starts;
see [Project and session state](../cli/project-state.md#runtime-state-growth).

`CheckpointManager.prune` calls the store's optional
`CheckpointStore.pruneCheckpoints` when it has one; `DiskCheckpointStore`
does. That form reads the checkpoint files alone, a few kilobytes each, so it
does not re-read the history log every iteration, and one damaged history
does not stop it. A store without it gets the old list-and-delete, with the
same outcome.

Retention is housekeeping. A prune that throws is logged
(`Checkpoint retention failed; older checkpoints are kept for now`) and the
run continues; the checkpoint the iteration needed was already written.

## Crash dumps

With `emergencySave: true`, a run installs handlers that write
`<runDir>/../emergency/<runId>.json` on `SIGINT`, `SIGTERM` or an uncaught
exception. `EmergencySaveManager.savePathFor(runDir, runId)` names that path.
`prepareReplayState({ fromCheckpoint: 'emergency' })` reads it back. The CLI
turns dumps on for every interactive turn and for `namzu run`.

A dump holds the whole conversation. `EmergencySaveManager.clearSave` had no
caller, so every dump stayed on disk. The kernel now removes one when a run
that continues it settles `completed`:

- the same run, resumed under its own id: its own dump;
- a replay forked from the dump: `prepareReplayState` returns the dump's path
  as `emergencySavePath`; pass it to `query({ supersedesEmergencySave })` and
  the dump is removed when the replay completes.

A run or replay that fails or pauses keeps the dump, which is still the only
record of the moment the original run died.

The CLI never resumes from a dump; it continues a conversation from its
session record under a new run id, which neither rule above reaches. So when
a turn completes, the CLI removes the dumps in that session's
`runs/emergency/` that are older than the turn's start
(`clearOutlivedEmergencySaves`, `packages/cli/src/integrations/state/retention.ts`).

## One Project per directory

Every path above is keyed by Project, so an id minted per run gives every run
a Project tree of its own. `runAgent` minted one per call. When no `projectId`
is passed, it now derives one from `workingDirectory` with
`projectIdForDirectory`, so a batch of runs in one directory, such as an eval
or a benchmark, shares one tree. `query` and `drainQuery` take identity
explicitly, as before.

The 79 `prj_*` trees measured in one home directory (250–500 MB each, from
2026-09-10 and -11) have the `projects/<id>/sessions/` shape of this layout.
Their prefixed ids come from a build older than the switch to UUID ids on
2026-09-06; batches of that period ran from frozen copies of the CLI. Which
call site minted them cannot be recovered from the deleted tree. The current
headless CLI is not one: it resolves one Project per checkout, and three
`namzu run` invocations in one directory leave one Project
(`scripts/benchmarks/cli-state-growth.mjs`). The call sites that still minted
one per call were `runAgent` and the CLI's scope-less `createAgentSession`.
Both now derive it from the directory.

The kernel eval suites (`packages/evals/kernel/*.eval.js`) create one scratch
directory per case. They now pass a path builder inside it and remove it when
the case ends; before, every case left its directory and run tree in the
system temporary directory.
