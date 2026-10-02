---
type: Reference
title: Pal lifecycle and activity observations
description: Live local-computer facts and authorized bounded metadata pages over an owned original Pal session journal.
resource: packages/sdk/src/pals/activity
tags: [sdk, pals, observation, activity, lifecycle]
status: stable
generated: { by: process:codex, at: "2026-10-02" }
---

# Pal lifecycle and activity observations

The SDK provides live computer observations and read-only pages from a Pal's
original conversation journal. Hosts can display these facts in CLI, desktop or
other clients. Observation consent is separate from message, wake and execution
consent. These APIs neither approve an action nor start an agent turn.

## Live computer lifecycle

`PalRuntime.onLifecycle(listener)` returns an idempotent unsubscribe function.
The listener receives frozen `PalLifecycleEvent` facts from that runtime instance:

| Fact | Fields beyond `type` and `palId` |
| --- | --- |
| `computer.starting` | none |
| `computer.ready` | admitted `generation` |
| `computer.start-failed` | `reason: 'unavailable'` or `'cleanup-required'` |
| `computer.stopping`, `computer.stopped`, `computer.stop-failed` | optional `generation` |
| `admission.acquired` | `generation`, `conversationId` |
| `admission.released` | `generation`, `conversationId`, `reason: 'released'` or `'closed'` |

An invalid rejected lease retained for cleanup has no accepted generation;
its stop facts omit a generation when its identity is invalid. Failed stops
retain ownership for an explicit retry. Releasing one conversation's admission
keeps its computer warm. Closing the runtime releases each acquired admission
once before stopping computers.

The callback can return `void` or a promise. Synchronous exceptions and rejected
promises are isolated; a pending observer does not block acquisition, release or
shutdown. Unsubscribe stops delivery to that listener and does not stop a Pal.
Listeners should perform observation work and issue control commands through
their host's separately authorized controls.

```ts
import type { PalLifecycleListener, PalRuntime } from '@namzu/sdk'

export function observeComputers(runtime: PalRuntime, listener: PalLifecycleListener) {
  return runtime.onLifecycle(listener)
}
```

These are live host facts, with no durable cursor or replay. A host subscribing
after startup reads its current display state separately. Facts contain no lease,
environment identifier, provider credential, raw error or private message body.
Guest retirement discovered outside a runtime transition does not manufacture a
historical stop event.

## An owned original activity journal

`createPalActivitySource(PalActivitySourceOptions)` captures an immutable
`PalActivityScope`: `tenantId`, `projectId`, `palId`, `profileRevision` and
`sessionId`. The pinned definition comes from `PalStore.getRevision`.
`authorize(scope, signal)` is a required trusted host callback for current
observation permission. It must grant only an exact allowed scope and returns
`true` to permit the read. A paused Pal remains observable when permission permits
it; observation never admits its computer or pays for a model call.

`openJournal(scope, signal)` is a trusted host port that returns the same original
journal through `PalActivityJournal.log` and `PalActivityJournal.bytes`. The log
port supplies its `sessionId`; `bytes` implements `LogBytes.size()` and bounded
`read(offset, length)`. For a disk log, use `DiskLogMedium` over that exact owned
log file. Do not supply a model-selected path, folded transcript, compaction
summary, renderer cache or unrelated journal. The port must honor cancellation
and keep its reads restricted to the captured owner.

Before projecting any record, the source verifies the journal's `session_started`
root, its tenant, project and exact pinned control `cwd`, and its Pal profile
origin `['namzu-pal', palId, profileRevision, sessionId]` under protocol `desktop`.
A child or fork root is rejected. Permission is checked before opening, again
after journal opening and size capture before original byte access, and again
after reading before publishing the page. Cancellation is checked across waits.

```ts
import { createPalActivitySource } from '@namzu/sdk'
import type { PalActivityCursor, PalActivitySourceOptions } from '@namzu/sdk'

export async function readStoredActivityPage(
  hostOptions: PalActivitySourceOptions,
  signal: AbortSignal,
  storedCursor?: PalActivityCursor,
) {
  const source = createPalActivitySource(hostOptions)
  return source.read({ signal, cursor: storedCursor, maxRecords: 64, maxReadBytes: 1024 * 1024 })
}
```

The host supplies actual permission and journal access in `hostOptions`. It may
save the returned cursor after successfully consuming the page, then resolve
that stored cursor for a later read or process restart.

## Cursor trust and verification limits

**A cursor is an unchanged previously emitted output stored and resolved by the
trusted host. Never accept a model, renderer or remote client's anchor directly.**
At a future client or channel boundary, resolve a server-stored cursor by an
authenticated opaque identifier before calling this SDK API.

`PalActivityCursor` contains `v: 1`, `scopeHash`, the exact root pointer, the
`after` pointer and that original record's `generation`. Each pointer holds
`seq`, byte `offset`, byte `length` and `sha256`. The scope hash binds the owner
and pinned profile; **it is not an authentication signature**.

Each read checks the root bytes and the supplied stored anchor bytes. It then
verifies every newly consumed successor's sequence, predecessor hash, session
and nondecreasing original generation. Previously consumed prefixes between the
root and cursor are not rescanned. A forged anchor could skip an earlier break;
the source does not claim whole-history proof from arbitrary client cursors.
Hosts requiring a fresh full-prefix check start without a cursor and consume
bounded pages, preserving each previously verified anchor. Future authenticated
cursor resolution belongs at the host's ingress boundary.

Changed root/anchor hashes, foreign scope, stale generation, truncated snapshots,
broken successors and incomplete trailing bytes reject the read with
`PalActivityIntegrityError`. The source never returns a cursor that advances
through an unverified partial record. Permission denial raises
`PalActivityAccessDeniedError`. These errors expose no raw journal body.

## Approved facts and bounded reads

`PalActivityFact` contains a stable opaque `id`, type, session and optional turn
ID, original `seq`, `generation` and UTC timestamp `at`. Its closed projection
may additionally contain validated activity, tool-use or checkpoint IDs,
activity type, status or review decision:

| Original record | Approved metadata |
| --- | --- |
| `turn_started`, `turn_resuming` | running status |
| `turn_paused` | checkpoint ID |
| `turn_completed`, `turn_failed` | terminal status, retaining cancellation |
| `activity_created`, `activity_updated` | activity ID, type on creation, status |
| `tool_executing`, `tool_completed` | bounded tool-use ID and status |
| `tool_review_requested`, `tool_review_completed` | request fact or decision enum |
| `checkpoint_created` | checkpoint ID |

Other original records advance the cursor without emitting a fact. Messages,
descriptions, model/provider names, tool names, arguments, results, raw errors,
private transcript bodies and screenshots are omitted. Selected fields are
validated independently even where an existing record schema checks only the
event envelope. Malformed projected metadata rejects the page. Historical
review metadata is an observation; it never authorizes replay or a new action.

`read({ signal, cursor?, maxRecords, maxReadBytes })` requires explicit limits:

- `maxRecords`: 1–256 new original records inspected, including omitted records;
  root and cursor anchors are additional verification reads.
- `maxReadBytes`: 1–16 MiB total requested journal bytes, including all anchors
  and limited line lookahead. The source does not call `head()`, `readAll()`,
  message folding or spill loading to materialize history.
- A record must fit the existing journal maximum of 4 MiB and the remaining byte
  budget. An insufficient budget or oversized record raises
  `PalActivityReadLimitError`; no partial page is published.

`PalActivityPage` returns frozen facts and cursor, `scannedRecords`, `readBytes`
and `complete`. `complete` means the captured byte boundary was reached; later
appends require another read. Each original record's pointer determines its
stable fact ID, so rereading a page or reopening the original journal after
process restart preserves identity. Compaction does not hide the retained
original activity records.

For durable host publication, use [Pal activity subscriptions](pal-subscriptions.md)
with separate observation, disclosure and recipient consent, verified turn
causality and the shared input ledger. The reader itself installs no automatic
wake loop, Team membership, external transport or action dispatcher.
Observations remain untrusted context and do not approve actions.
