---
type: Reference
title: Session log
description: The one append-only, hash-chained JSONL file per session that records everything a session did, its record schema, the turn rules it enforces, and the layout under NAMZU_HOME.
resource: packages/sdk/src/types/session/records.ts
tags: [sdk, sessions, turns, persistence, storage, schema]
status: stable
generated: { by: process:claude-code, at: 2026-09-21T00:00:00Z }
---

# Session log

The kernel's model is **session → turn → message**. A session is one
conversation with one agent. A turn is one unit of work inside it: a user
prompt, a goal round, a resident step or a verification step, and everything
the agent did to answer it. A subagent is a child session, with its own log.

Each session has exactly one log: an append-only JSONL file whose lines are
records, each linked to the one before it by hash. The log is the source of
truth. Every other store (the SQLite index, checkpoint documents, the
`<child>.meta.json` files) can be rebuilt from, or is checked against, the
logs.

This page describes the schema and the rules. The schema is code:
`packages/sdk/src/types/session/records.ts` (records and documents),
`events.ts` (the live events), `turn.ts` (turns, settlement, the
one-active-turn error) and `checkpoint.ts`. The writer and reader are
`SessionLog` (`DiskSessionLog`, `InMemorySessionLog`,
`packages/sdk/src/store/session-log/`); the index over every log is
[The session index](sqlite-sessions.md). The per-run layout this replaces is
mapped, for hosts with an old tree, in
[From the per-run layout](#from-the-per-run-layout).

## Where the files are

`NAMZU_HOME` (default `~/.namzu`, resolved by `resolveNamzuHome`) is shared by
the SDK and the CLI. `SessionPaths` (`packages/sdk/src/session/paths.ts`)
computes every path below and checks every id that becomes a path segment.

```text
$NAMZU_HOME/
├── index.sqlite                        rebuildable index (PRAGMA user_version = 1)
└── projects/<slug>/
    ├── project.json                    {"v":1,"kind":"project","projectId":…,"cwd":…,"slug":…,"createdAt":…}
    ├── memory/   residents/<agent-key>/   worktrees/<label>/
    ├── <session-id>.jsonl              the session log
    └── <session-id>/
        ├── subagents/<child-id>.jsonl, <child-id>.meta.json, <child-id>/subagents/…
        ├── tool-results/<sha256(tool-use id)>.txt, ….txt.manifest.json
        ├── checkpoints/<checkpoint-id>.json
        ├── budgets/<root-turn-id>.json   (root sessions only)
        ├── tasks/<task-id>.json   feedback/<message-id>.json   goals/<goal-id>.json
        ├── file-history/
        ├── lease.<fence>.json            one per claim; the highest fence is the holding
        └── lease.json                    {"v":1,"kind":"lease","holder":…,"fence":…,"expiresAt":…} (a readable copy)
$TMPDIR/namzu-<user>/<slug>/<session-id>/scratchpad/
```

- **Slug.** `slugForCwd` replaces every character of the canonical working
  directory outside `[A-Za-z0-9]` with `-`. A POSIX path starts with `/`, so
  its slug starts with `-`; `C:\…` gives `C-…`; a UNC path gives `--…`. A slug
  therefore never looks like a UUID, which is how a reader tells a slug from
  a legacy `projects/<uuid>/` directory. A slug longer than 200 characters is
  cut and suffixed with 8 hex digits of the path's SHA-256.
- **Project id.** `ensureProject` mints the id once, into `project.json`. The
  document is written complete to a private temporary file and hard-linked
  into place, which fails if another process got there first, so of two
  racing processes exactly one mints the id and the other adopts it. If the
  existing `project.json` names a different directory, the project moves to
  `<slug>-<first 8 hex of sha256(cwd)>`.
- **Temporary root.** `tempRoot` uses the numeric uid where the platform has
  one, otherwise 12 hex digits of the SHA-256 of the user name. On POSIX the
  directory is mode 0700 and refused if it is a symlink, owned by another
  uid or open to others. On win32 a symlink or junction is refused.
- **Nothing generated goes under the working directory.** Project config
  that people write (`<cwd>/.namzu/agents`, `skills`, `commands`, `plugins`,
  `MEMORY.md`) is read from there, and never written.

## Ids

Every id the kernel mints is a UUID version 7 (see [Ids](ids.md)): records,
turns, sessions and checkpoints sort by creation time as plain strings. A
caller-side id (an AG-UI thread, an A2A context, a desktop session) is never
used as a namzu id; it is recorded as an origin or external reference and may
be any string.

## A line, and the chain

One record per line: the record as JSON, then `\n`. A line's hash is the
SHA-256 of exactly those bytes, the newline included; nothing is
canonicalised (`recordSha256`, `parseSessionLogLine`,
`formatSessionLogLine` in `packages/sdk/src/session/log-hash.ts`). A record is
at most 4 MiB (`SESSION_RECORD_MAX_BYTES`); a larger body is spilled to
`tool-results/`, and the spill file and its manifest are on disk before the
record that points at them.

Every record carries this envelope:

| Field | Meaning |
|---|---|
| `v` | Schema version, `1` (`SESSION_RECORD_SCHEMA_VERSION`). A reader refuses any other value. |
| `type` | The discriminant (below). |
| `id` | The record's own UUIDv7. |
| `sessionId` | The session this log belongs to. |
| `turnId` | The turn the record belongs to; absent on a record outside any turn. A record never names a turn that has closed (see [Children](#children-that-outlive-their-turn)). |
| `seq` | 1-based and contiguous. |
| `ts` | ISO-8601 in UTC, with `Z`. |
| `prev` | `{seq, offset, length, sha256}` of the previous line; `null` only at seq 1. |
| `prevText` | Optional skip link to the previous record that carries text, for evidence search. |
| `gen` | The fencing token of the lease the writer held. |

Chain rules:

- Seq 1 is `session_started`, at offset 0, and no other record is.
- A strict read refuses any break: a `prev` that does not name the previous
  line's seq, offset, length and hash. A tolerant read stops at the first
  break and reports how far the log is intact.
- A torn tail (a last line with no newline, left by a crash mid-append) is
  truncated when the log is opened, and a `log_repaired` record says how many
  bytes went and which seq was the last good one.
- An append whose `gen` is lower than the lease's fence is refused, so a
  writer that lost its lease cannot interleave with its successor.

## Records

A record is either a **live event that is persisted**, or a **record-only
type**.

### Persisted events

The live event union (`SessionEvent`, `packages/sdk/src/types/session/events.ts`)
has 62 type literals. Every one except the four high-volume ones —
`text_delta`, `tool_input_delta`, `reasoning_delta` and `tool_progress` — is
appended as a record of the same `type`. The record is the event with
`sessionId` and `turnId` moved to the envelope and `lineage` dropped (it
follows from `session_started.parent`). Its payload is the event's.

The turn lifecycle events are checked field by field:

| Type | Payload |
|---|---|
| `turn_started` | `userMessageId`, `systemPrompt?`, `config` (model, token budget, timeout and the other durable limits), `origin?`, `budget?` (`{rootSessionId, rootTurnId, accountId}`) |
| `turn_paused` | `reason`, `checkpointId`, `failure?`, `providerError?`, `explanation?`, `budget?`. Ends a segment; **not** terminal. |
| `turn_resuming` | `fromCheckpointId`, `resolvedDecisionId?` |
| `turn_completed` | `result` (a preview when `resultSpill` holds the whole answer), `resultSpill?`, `stopReason?`, `cancelCause?`, `budget?`, `settlement` |
| `turn_failed` | `error`, `failure?`, `providerError?`, `explanation?`, `budget?`, `settlement` |
| `child_session_spawned` | `childSessionId`, `toolCallId`, `kind`, `description`, `path` (relative to the session directory), `batch?` (`{batchId, name, phase?}`), `budgetAccountId?` |
| `child_session_messaged` | `childSessionId`, `messageId`; `turnId` optional (below) |
| `child_session_idled` | `childSessionId`; `turnId` optional (below) |

`settlement` is `{status, iterations, usage, cost, durationMs,
resultMessageId?, resultSource, structuredOutput?, servingProvider?,
abandonedTaskIds, abandonedJobIds}`. `status` is `completed` or `cancelled`
on `turn_completed` and `failed` on `turn_failed`: the terminal verdict is the
record's type. `failure.code` on `turn_failed` is `interrupted` or
`abandoned` when the session log itself closed the turn (see below).

The other persisted events are checked for their envelope and type, and must
not carry `lineage`, `generation` or `schemaVersion`. Events that can
only happen inside a turn (iterations, messages, tool calls, reviews, plans,
spawning a child) must carry `turnId`, and the TypeScript view
(`SessionRecord`, `SessionEventRecord`) types their `turnId` as present; the
list is exported as `TurnBoundSessionEventType`. Events a host can cause between turns — a
manual compaction, a background job exiting, an approval-policy change, a
session hook, task and sandbox bookkeeping — may omit it.

### Record-only types

| Type | Payload |
|---|---|
| `session_started` | `projectId`, `tenantId?`, `topicId?`, `cwd`, `agent {id, name, type?}`, `parent?` (`{sessionId, turnId, toolCallId, rootSessionId, depth, kind}` for a child session), `forkedFrom?` (`{sessionId, turnId, checkpointId}`), `origin?` |
| `session_updated` | `title?`, `titleSource?` (`derived`/`named`), `archived?`, `approvalPolicy?`, `externalRefs? {add?, remove?}` |
| `message` | `messageId`, `role`, `kind?` (`prompt`, `steering`, `auto-continuation`, `context`), `content` (the message), `spill?` |
| `message_replaced` | `targetMessageId`, `content`, `reason` (`pin-slot`, `guardrail_blocked`, `guardrail_rewritten`, `review`, `outstanding_work`, `structured_output`, `history-repair`), `spill?` |
| `checkpoint_written` | `checkpointId`, `iteration`, `throughSeq`, `throughSha256`, `path`, `docSha256` |
| `checkpoint_pruned` | `checkpointIds` |
| `decision_requested` | `decisionId`, `checkpointId`, `request` (what the human is shown), `deadlineAt?` |
| `decision_resolved` | `decisionId`, `decision`, `resolvedBy` |
| `decision_expired` | `decisionId` |
| `compaction` | `compactionId`, `strategy`, `trigger` (`auto`/`manual`), `replacesSeqRange`, `summary` (messages, or a spill), `keptMessageIds`, `pinned?`, `tokensBefore`, `tokensAfter` |
| `child_session_ended` | `childSessionId`, `status`, `stopReason?`, `resultMessageId?`, `usage`, `cost`; `turnId` optional (below) |
| `audit` | `auditId`, `actor`, `persona?`, `action`, `tool?`, `resource?`, `outcome` (`success`, `failure`, `refused` or `approved`), `cost?`, `reason?`, `traceId?` and `spanId?` (together or not at all) |
| `budget_bound` | `rootSessionId`, `rootTurnId`, `accountId` |
| `log_repaired` | `truncatedBytes`, `lastGoodSeq` |

Three payload fields are checked against the rest of the record by
`SessionRecordSchema`, not by the per-type schema alone: a `message` record's
`role` is its `content.role`; `checkpoint_written.throughSeq` is below the
record's own `seq`, since a checkpoint covers only records already written; and
a `compaction`'s `replacesSeqRange` `[fromSeq, toSeq]` is ascending and before
the record, `fromSeq <= toSeq < seq`.

`origin` is `{protocol, externalSessionId?, externalTurnId?, kind?, goalId?,
round?}`, where `protocol` is `cli`, `sdk`, `ag-ui`, `a2a`, `acp`, `http`,
`desktop` or `resident`. An external reference is `{protocol, kind, externalId}`
with `kind` `session`, `thread` or `context`. The index's `external_refs` table
is derived only from these two, never written directly, so it survives a
rebuild.

An `audit` record holds everything an `AuditEvent`
(`packages/sdk/src/types/session/audit.ts`) records: `who` becomes `actor`
plus `persona`, `what` is flattened into `action`, `tool` and `resource`, and
the envelope's `seq`, `ts` and `turnId` stand for the event's own sequence,
timestamp and turn. A session-level entry omits `turnId`. `replayAudit` reads
them back as an `AuditSummary`.

### Children that outlive their turn

A delegated child can still be running when the parent turn that spawned it
ends: the settlement's `abandonedTaskIds` names such workers. Only
`child_session_spawned` is bound to a turn. `child_session_messaged`,
`child_session_idled` and `child_session_ended` carry the spawning turn's id
while that turn is open and omit it once the turn has closed, even when a
later turn is running: naming the closed turn would break the envelope rule,
and naming the running one would attribute the child to the wrong turn. A
reader finds the spawning turn through `childSessionId` and the
`child_session_spawned` record (or the meta file's `parentTurnId`). The
`batch-annotated` fixture has one child of each kind.

The `compaction` record is what the fold reads. The live
`compaction_completed`, `compaction_shed` and `compaction_tool_results_cleared`
events are persisted beside it as history: `compaction_shed` keeps what a pass
removed in the log for audit and undo.

## Turn rules

- **One active turn per session.** The active turn is the last `turn_started`
  with no `turn_completed` or `turn_failed` for its `turnId`. It is `paused`
  when its last segment record is `turn_paused`, `running` while a live lease
  is held, and `interrupted` otherwise (its process is gone).
- **Starting another turn is refused** with `TurnInProgressError {sessionId,
  activeTurnId, state}`. `isTurnInProgressError` recognises one, including
  from another copy of the package, so a protocol server can map it.
- **An interrupted turn** is closed only when the caller opts in: beginning
  the next turn with `abandonInterrupted` first appends
  `turn_failed` with `failure.code: 'interrupted'`.
- **A recoverable failure pauses the turn.** A provider fault classified
  retryable (a rate limit, an outage, a stalled stream) that survives the
  turn's retries and fallbacks appends `turn_paused` naming the turn's newest
  checkpoint, and `Turn.lastProviderError` carries the classification. A turn
  that fails this way before writing a checkpoint of its own (a 429 on its
  first request, or on a later request made before any checkpoint: after a
  `max_tokens` continuation, a structured-output re-prompt, steering
  delivered with prose, the outstanding-work hold) first commits one of the
  turn as it stood where its iteration loop began. That checkpoint carries
  the iteration the loop began at (`0` for a fresh turn, the restored count
  for a resumed one), covers the log only through that point and counts
  none of the guards used since, so the resume restarts the turn from where
  its loop began. Everything the turn did after that point is discarded:
  every iteration it ran before the fault, completed ones included (each
  continuation request opens a new iteration, so a chain of `max_tokens`
  continuations is several), with the partial answers and prompts they
  added, is not carried into the resumed request.
  A failure before the loop begins (in a
  `turn_start` hook, for one) has no such point and fails the turn. A
  permanent fault (a bad key, a malformed request) fails it at any point.
- **A paused turn is never closed implicitly.** It continues under the same
  `turnId` through `resumeSession`, or is closed by `abandonTurn`, which
  appends `turn_failed` with `failure.code: 'abandoned'`.
- **What is a new turn:** a user prompt, a goal round, a resident step and a
  verification step (`origin.kind` says which). Steering and automatic
  continuation are `message` records inside the current turn. The prompt that
  opens a turn is the `message` record right after `turn_started`, named by
  its `userMessageId`.
- **Token budget:** a ledger per root turn, keyed by `(rootSessionId,
  rootTurnId)`. A child session's turns bind to the root turn that spawned
  them; a resumed turn reuses its key; a new turn opens a new ledger, so a
  limit that changed between turns is not a conflict.

## A writer that stops

A turn holds its session's lease while it runs, renewed at half-life (the
`TurnRecorder` default time-to-live is five minutes). A process that exits
without releasing it leaves the session refusing every other writer until the
lease expires, although nothing is writing.

`releaseHeldSessionLeases({ timeoutMs? })` is for a process on its way out. It
releases every lease any log in the process holds, each in that log's write
order (after the append in flight, never under a half-written record), and
resolves `{ released, unfinished }` without throwing. A running turn is left
**interrupted**: nothing is appended for it, because the process cannot know
how far it got, and the next writer closes it explicitly (`abandonTurn`,
`resumeSession`, or `beginTurn` with `abandonInterrupted`). From the first call
on, every claim in the process is refused with `SessionLeasesReleasedError`, so
a turn still unwinding cannot renew or retake the lease it just gave up, and a
queued prompt cannot start a new one.

The CLI calls it on SIGTERM, SIGHUP and SIGINT in the TUI and in `namzu exec`,
in either mode (see
[Exit codes of `namzu exec`](../cli/exec-exit-codes.md#an-invocation-stopped-by-a-signal)).

A process killed with SIGKILL, or one that crashes outright, runs no code, and
its lease is freed only by expiry. A liveness check — "the holder's pid is
gone, so take the lease now" — is deliberately not made. It would be sound
only if the checker provably shared the holder's process table, and the
identity that could show that (the kernel's boot id, the pid namespace, the
pid and its start time) is also shared by a cloned VM or a restored container
checkpoint running beside the original, so a live writer on another machine
could be judged dead. The fence would still refuse that writer's appends, but
its turn would be broken while it was running. Expiry cannot make that
mistake.

## The answer, and the fold

`turn_completed.result` is the authoritative answer, after guardrail, review,
outstanding-work and structured-output overrides. When it differs from the
text of the turn's last assistant message, the writer first appends
`message_replaced` for that message, with the answer as its content and the
override as its reason, and `settlement.resultSource` names the same override.

The context a session carries into its next request — and what a transcript
or a protocol snapshot shows — is the **fold** of its log:

1. the latest `compaction` record's summary;
2. then its kept messages;
3. then every `message` after its `replacesSeqRange`;
4. with every `message_replaced` applied.

So every reader sees the redacted or rewritten answer, and the raw text stays
in the log for audit only. A checkpoint's context is the fold of the log up to
its `throughSeq`, which equals the session's fold at that point because no
other turn can interleave.

## Documents beside the log

Each has `v` and `kind`, and an unknown version is refused, never migrated.

- **Checkpoint** (`kind: 'checkpoint'`, `parseCheckpoint`): `checkpointId`,
  `sessionId`, `turnId`, `iteration`, `throughSeq`, `throughSha256`, usage and
  cost, the budget reference, the iteration and elapsed-time guards, the review
  attempts already consumed, `latestUserMessageId?`, the compaction working
  state, the trace to continue, `turnCreatedAt` and `createdAt`. It holds no
  messages. A restore refuses it when its hash differs from its
  `checkpoint_written` record's `docSha256`, or when the record at
  `throughSeq` does not hash to `throughSha256`. A checkpoint from the older
  layout is refused by name. A child session's checkpoints are in its own
  directory, `<parent-session-dir>/subagents/<child-id>/checkpoints/`. A
  checkpoint scope names only the session, so `DiskSessionCheckpointStore`
  takes the session's place in the tree as its `session` option, and a
  `DiskSessionLog` reports that place as `locator`: the one
  `DiskSessionLog.at` was given, or, for a log built from a file path such as
  the index's `logPath`, the one the path spells out
  (`…/<parent-id>/subagents/<child-id>.jsonl`). A log whose file is not named
  `<session-id>.jsonl` has no `locator`. The path does not say which project
  the file is in, so `resolveSessionStorage` uses a log's `locator` only when
  its `paths` put that locator's log at this very file. Any other log (no
  `locator`, or a `<session-id>.jsonl` kept outside the layout) it places like
  a child named only by `parentSessionId`, with no log: under wherever its
  parent's log is found.
- **Child-session meta** (`kind: 'child-session'`): identity, parent, root,
  depth, the spawning tool call, agent type, description and status. A
  convenience; the child's log wins on any disagreement.
- **Lease** (`kind: 'lease'`): `holder`, `fence`, `expiresAt`.
- **Token budget** (`kind: 'token-budget'`, version 2,
  `<root-session-id>/budgets/<root-turn-id>.json`): the ledger of one root
  turn and every child session it spawned. A version 1 snapshot is refused.
  See [Token budgets](token-budgets.md).
- **Project** (`kind: 'project'`): as above.

## From the per-run layout

Up to `@namzu/sdk` 43, a disk-backed invocation of the kernel (43.x called it
a run) wrote one directory,
`<root>/projects/<projectId>/sessions/<sessionId>/runs/<run-id>/`, holding
`run.json`, `transcript.jsonl`, `audit.jsonl`, `messages.json`, `report.md`,
`token-budget.json`, `checkpoints/` and a `history/` log the checkpoints
referenced. That layout is gone: the model is session → turn → message, and
each session is the one log this page describes. Each old file went here:

| Old file | Now |
|---|---|
| `transcript.jsonl` (every event, hash-chained) | The session log itself, `projects/<slug>/<session-id>.jsonl`: every persisted event is a record, chained by `prev` |
| `audit.jsonl` | `audit` records in the same log |
| `run.json` (status, counters) | Derived from `turn_started` and `turn_completed`/`turn_failed` (`settlement`); listed by `SessionIndex.listTurns` |
| `messages.json`, `history/messages.<g>.jsonl`, `history/edits.<g>.jsonl` | `message` and `message_replaced` records, each message stored once; read with `foldSessionMessages` |
| `report.md` (the final answer) | `turn_completed.result` |
| `checkpoints/<id>.json` | `<session-id>/checkpoints/<id>.json`, committed by a `checkpoint_written` record. A checkpoint holds no messages: its context is the fold of the log through `throughSeq`. |
| `token-budget.json` | `<root-session-id>/budgets/<root-turn-id>.json` (snapshot v2), one ledger per root turn |
| `emergency/<run-id>.json` crash dumps | Nothing. The log is written as the turn goes and a checkpoint is taken every iteration, so there is nothing left for a dump to hold. |
| `children/<child-run-id>/` | A child session: `<session-id>/subagents/<child-id>.jsonl` and `<child-id>.meta.json` |
| `<runs>/index.json`, `state/sessions.sqlite` | `$NAMZU_HOME/index.sqlite`, rebuilt from the logs |

`<root>` is no longer chosen by a `pathBuilder` or by `defaultStateRoot()`:
everything is under `NAMZU_HOME` (default `~/.namzu`), in the working
directory's `projects/<slug>/`, and never under the working directory itself.
`DefaultPathBuilder`, `PathBuilder`, `defaultStateRoot`, `NAMZU_STATE_DIR` and
`projectIdForDirectory` are removed; `SessionPaths` and `ensureProject`
replace them.

The new version reads none of these files. There is no migration.

- Resolve or abandon every parked turn with `drainRuns` or `resumeRun` on
  43.x before upgrading (43.x called it a run); one parked when you upgrade
  cannot be resumed.
- A checkpoint or run state from 43.x (its per-run record), a token-ledger snapshot v1 or a
  checkpoint of kind `run-checkpoint` handed to the new version is refused by
  name, never misread.
- Keep or delete the old directories as you see fit. The CLI's `namzu state`
  lists them as `legacy` and never touches them.

## Fixtures

`packages/sdk/src/__fixtures__/session-log/` holds one log per case: `valid`,
`torn-tail`, `repaired`, `broken-chain`, `compaction`, `paused-then-resumed`,
`abandoned`, `guardrail-replaced`, `child-sessions` (a parent, its child
under `subagents/`, and the meta file), `batch-annotated` (one child ends in
its turn, one after it) and `origin-external-refs`. `build.ts` beside them generates every byte, and
`session-log-fixtures.test.ts` requires the committed files to equal its
output, every complete line to round-trip through `SessionRecordSchema`, and
the chain to hold everywhere except where a case breaks it on purpose.
