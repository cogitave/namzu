---
type: Reference
title: The session index
description: The rebuildable index over every session log under NAMZU_HOME — SqliteSessionIndex where node:sqlite loads, ScanSessionIndex elsewhere — what it answers, how it stays current, and why deleting it loses nothing.
resource: packages/sdk/src/store/session-index/index.ts
tags: [sdk, storage, sessions, sqlite, index]
status: stable
generated: { by: process:claude-code, at: 2026-09-21T00:00:00Z }
---

# The session index

The [session log](session-log.md) is the source of truth: one append-only file
per session. Listing sessions, finding a session's turns, or searching across
them by reading every log would be slow, so the SDK keeps an index beside the
logs, `$NAMZU_HOME/index.sqlite`. Every row in it is derived from log records
and nothing is written to it directly, so deleting it loses nothing: the next
open rebuilds it.

```ts
import { openSessionIndex } from '@namzu/sdk'

const index = await openSessionIndex() // home defaults to resolveNamzuHome()
const recent = await index.listSessions({ rootsOnly: true })
index.close()
```

`openSessionIndex({ home?, path?, backend? })` picks the backend. With the
default `backend: 'auto'` it opens `SqliteSessionIndex` when `node:sqlite`
loads (Node.js 22.13 or newer; `sqliteAvailable()` says whether it does), and
otherwise `ScanSessionIndex`, which reads the logs into memory and gives the
same answers. The SDK's own floor is Node.js 20, and importing it never loads
SQLite.

## What it answers

| Method | Answer |
|---|---|
| `getSession(id)`, `listSessions({ slug?, rootsOnly?, includeArchived? })` | Sessions: parent and root, depth, title, archived, `idle`/`running`/`paused`, and where the log is and how far it was read |
| `listTurns(sessionId)` | A session's turns: status, stop reason, times, tokens, cost, a 200-character preview of the prompt, and `origin.kind` |
| `listChildren(sessionId)` | The child sessions a parent log names (`ChildSessionSummary`), with the child's own row once its log is indexed |
| `listPendingDecisions({ sessionId? })` | Decisions parked turns are waiting on, with their checkpoint and deadline. `namzu drain` and `drainParkedTurns` start here. |
| `batches({ sessionId? })` | Groups of children spawned together, from `child_session_spawned.batch` |
| `resolveExternal(protocol, kind, externalId)`, `listExternalRefs(sessionId)` | Which session a caller-side id (an AG-UI thread, an A2A context, an ACP or desktop session) names. Any string is accepted. |
| `searchEvidence({ … })` | Full-text search over message and tool text (FTS5 in SQLite), with the session, turn and seq of each hit |

The index cannot see leases, so an interrupted turn reads `running` here. The
session log itself (`activeTurn()`) is what tells `running`, `paused` and
`interrupted` apart.

## How it stays current

- **Derived only.** Rows come from records. `external_refs` in particular
  comes only from `session_started.origin`, `turn_started.origin` and
  `session_updated.externalRefs`, which is what lets a mapping survive a
  rebuild.
- **Stale sessions are re-read.** Each session row records the log's byte
  length and the hash of its head record. `staleness(location)` compares
  them with the file: `fresh`, `grown` (appended since; the index continues
  from its head), `truncated` or `rewritten` (the session is re-derived from
  seq 1), `unindexed` or `missing`. `refresh` acts on the answer and `sync`
  does it for every log under a home.
- **Rebuilt, never migrated.** An index that is missing, or at a
  `PRAGMA user_version` other than `SESSION_INDEX_VERSION` (1), is rebuilt
  from the logs into a temporary file and renamed over the old one. Two
  processes rebuilding at once both finish; one index remains, complete.
- **Incremental writes** take `BEGIN IMMEDIATE`, so two writers never
  interleave a session's rows.

## Replacing the old session stores

`SqliteSessionStore` and `sessions.sqlite` are gone, and with them the
`SessionStore` message methods (`appendMessage`, `replaceMessages`,
`loadMessages`, `loadSessionMessages`). Messages are written only by the turn
recorder, into the session log, and read with `foldSessionMessages`; listing
is this index. An existing `sessions.sqlite` is not read: `namzu state`
reports it as legacy.
