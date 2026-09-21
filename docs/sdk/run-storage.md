---
type: Reference
title: Durable run storage
description: Every file a disk-backed run writes, which one is authoritative for what, how checkpoints reference one stored history instead of copying it, and how their number is bounded.
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

## What each file is for

One record is authoritative for each concern. The rest are derived from it or
are small enough that keeping them costs nothing.

| File | Concern | Written by | Read by | Status |
|---|---|---|---|---|
| `transcript.jsonl` | Every run event, in order, hash-chained (`previousRecord`) | `RunDiskStore.appendEvent` | `readRunEventsIn` (public), `readCompletedTools` (a resume skips calls that already finished), evidence recall, the CLI's replay, search and export | Authoritative. The chain is what makes it evidence. |
| `audit.jsonl` | The audit trail, on its own sequence | `RunDiskStore.appendAuditEvent` | `readAuditEvents` (public); `RunPersistence.init` continues its sequence | Authoritative. |
| `run.json` | Status, counters, metadata | `RunDiskStore.writeRunMeta`, at start and at settle | `RunDiskStore.listChildren`, evidence sources, the CLI's search and inspection | Authoritative. Holds a message count, never messages. |
| `messages.json` | The history the run settled with, and the event it is valid through (`namzu.run-message-snapshot.v1`) | `RunDiskStore.writeMessages`, once, at settle | `RunStore.readMessages` / `readRunMessagesIn` (public), `RunQuery`, the CLI's delegated-child view | Public format, kept. One copy per run. |
| `checkpoints/<checkpointId>.json` | One resume point: counters, budget, compaction state, a park | `RunDiskStore.writeCheckpoint` | resume, human-in-the-loop parks, replay, `listDurableRuns` | Authoritative. References its messages; see below. |
| `checkpoints/history.jsonl`, `checkpoints/history-edits.jsonl` | The messages every checkpoint of the run references | `RunDiskStore.writeCheckpoint` | the checkpoint readers above, through the store | Authoritative for checkpoint messages. |
| `token-budget.json` | The durable token ledger | `DiskTokenBudgetStore` | budget admission and resume | Authoritative. |
| `report.md` | The run's final answer as text | `RunDiskStore.writeReport`, at settle, when there is one | people; the CLI points at it for a delegated child | A copy of `run.result`, a few hundred bytes. |
| `../index.json` | A row per top-level run in the directory | `RunDiskStore.addToIndex` | `RunDiskStore.listRuns`, deprecated | Deprecated with its reader; use `listDurableRuns`. |

Conversation history across turns is not a run concern. The CLI keeps it in
its session database (`state/sessions.sqlite`); an SDK host keeps it wherever
its `SessionStore` does. Before 2026-09-12 the CLI also wrote `session.json`,
`messages.jsonl` and `index.json` per session through the disk session store;
it no longer does.

## Checkpoints reference one stored history

A run takes a checkpoint every iteration (`runConfig.checkpointEvery`,
default 1) and another at every tool review. Until schema version 3 each one
carried the whole message history inline, so an N-iteration run wrote the
history N times: quadratic in the run's length. On one machine that came to
19,014 checkpoint files and 6.33 GB, with one run holding 532 checkpoints of
about 1.5 MB each, out of 7.0 GB of runtime state in all.

A version-3 checkpoint carries a `history` reference instead of `messages`:

```json
{
  "format": "namzu.checkpoint-history.v1",
  "count": 103,
  "sha256": "b1a8…",
  "segments": [[0, 0, 469, 2], [1, 12085, 254, 1], [0, 469, 171335, 100]]
}
```

Each segment is `[log, byte offset, byte length, line count]` in one of the
run's two logs, and `sha256` covers every referenced line in order. Each
distinct message is written once. A message that extends the history (part of
the run of new messages at its end) goes to `history.jsonl`, so the history the
run keeps appending to stays one contiguous range. Any other new message is an
edit and goes to `history-edits.jsonl`. Edits include the working-memory slot
a pinned fact rewrites every iteration, a compaction's summary, and a tool
result replaced by its placeholder. A checkpoint therefore costs a few ranges
per edit rather than a copy of the conversation.

Readers are unchanged. `readCheckpoint`, `listCheckpoints` and every caller
above them still receive an `IterationCheckpoint` with its `messages`. The
store resolves the reference, and a listing reads each log once, however many
checkpoints it resolves.

What is kept from the inline format:

- **Refusal over a partial read.** A missing, truncated or altered log fails
  the digest, and the checkpoint is refused with the same strictness as a
  damaged inline one. A resume never continues from a history it cannot vouch
  for.
- **Old checkpoints read as they are.** A checkpoint with inline `messages`
  (schema 1 or 2) is read exactly as before. Only new writes use the logs.
- **Newer files are refused by older builds.** A build that predates schema 3
  refuses a version-3 checkpoint instead of reading one with no messages.
  Upgrade every process that resumes a run before any of them writes to it.
- **Concurrent writers.** Appends are single `O_APPEND` writes. When a
  writer finds the log at a length it did not predict, it rebuilds its index
  from the file instead of trusting its own offsets. A torn last line is ended
  before the next append, as the transcript's is.

The logs are never shortened. Pruning a checkpoint removes its file, not the
lines it referenced, so a run's logs hold at most one copy of every message it
ever checkpointed.

Checkpoint files are written as compact JSON. They are read by the store, not
by people, and indentation was a third of their bytes.

Measured with `scripts/benchmarks/runtime-state-growth.mjs`, a scripted run in
which every iteration calls a tool returning about 4 KB and pins a fact,
through the real disk stores:

| Iterations | Checkpoint files | Checkpoint bytes, schema 2 | Checkpoint bytes, schema 3 (records + logs) | Largest checkpoint, 2 → 3 |
|---|---|---|---|---|
| 50 | 98 | 10,206,928 | 1,133,961 + 183,939 | 202,036 → 16,041 |
| 200 | 398 | 108,807,126 | 6,674,382 + 968,424 | 480,910 → 21,949 |

What remains in a checkpoint is mostly the compaction state it snapshots
(`workingState`, about 15 KB here, bounded by the compaction manager's own
caps) and one range per edited message.

## Bounding how many there are

`runConfig.pruneKeepLast` keeps the newest N checkpoints after each iteration
checkpoint. It never collects one whose park is unresolved. The default is
`undefined`: every checkpoint is kept. `BaseAgentConfig.pruneKeepLast` forwards
it from `ReactiveAgent` and `SupervisorAgent`, which is how a host bounds
delegated children as well.

With `pruneKeepLast: 10`, the 50-iteration run above leaves 10 checkpoint
files, 160,407 bytes, beside logs of 183,939 bytes: 19 files and 1,339,256
bytes for the whole run, against 105 files and 11,201,811 bytes before.

## Crash dumps

With `emergencySave: true`, a run installs handlers that write
`<runDir>/../emergency/<runId>.json` on `SIGINT`, `SIGTERM` or an uncaught
exception. `EmergencySaveManager.savePathFor(runDir, runId)` names that path.
`prepareReplayState({ fromCheckpoint: 'emergency' })` reads it back. The CLI
turns dumps on for every interactive turn.

A dump holds the whole conversation. Once the same run, resumed under its own
id, settles `completed`, its persisted record is newer than the dump, so the
kernel removes the dump then (`EmergencySaveManager.clearSave`). Nothing did
before: neither the kernel nor the CLI read their own dumps back, so every
crash left a dump behind. A resume that fails or pauses keeps the dump, which
is still the last record of a moment the run did not survive. A replay that
forks a new run from a dump does not remove it; that run has its own id, and
the dump still belongs to the run that crashed.
