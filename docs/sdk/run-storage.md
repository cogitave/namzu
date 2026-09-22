---
type: Reference
title: Durable run storage (removed)
description: The per-run directory layout of @namzu/sdk 43 and earlier, which no longer exists; where each of its files went in the session log layout, and what a host with an old tree does about it.
resource: packages/sdk/src/store/session-log/index.ts
tags: [sdk, persistence, storage, legacy]
status: deprecated
generated: { by: process:claude-code, at: 2026-09-21T00:00:00Z }
---

# Durable run storage (removed)

Up to `@namzu/sdk` 43, a disk-backed run wrote one directory per run,
`<root>/projects/<projectId>/sessions/<sessionId>/runs/<run-id>/`, holding
`run.json`, `transcript.jsonl`, `audit.jsonl`, `messages.json`, `report.md`,
`token-budget.json`, `checkpoints/` and a `history/` log that the checkpoints
referenced. That layout is gone, together with the run: the kernel's model is
now session → turn → message, and each session is **one** append-only,
hash-chained log. Read [Session log](session-log.md) for the layout and record
schema, and [The session index](sqlite-sessions.md) for listing and search.

## Where each file went

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

## A host with an old tree

The new version reads none of these files. There is no migration.

- Resolve or abandon every parked run with `drainRuns` or `resumeRun` on
  43.x before upgrading; a run parked when you upgrade cannot be resumed.
- A checkpoint or run state from 43.x, a token-ledger snapshot v1 or a
  checkpoint of kind `run-checkpoint` handed to the new version is refused by
  name, never misread.
- Keep or delete the old directories as you see fit. The CLI's `namzu state`
  lists them as `legacy` and never touches them.
