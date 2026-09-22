---
type: Reference
title: Project and session state
description: How the CLI maps a working directory to a project under NAMZU_HOME, what a session and a turn are, where each piece of generated state lives, and what happens to state an earlier CLI wrote.
resource: packages/cli/src/integrations/sessions/store.ts
tags: [cli, ids, storage, sessions]
status: stable
generated: { by: process:claude-code, at: 2026-09-21T00:00:00Z }
---

# Project and session state

The working directory is where tools execute. The Project groups the
conversations and stored memory that belong to that directory. A Session is
one conversation; a Turn is one unit of work inside it — a prompt you send, a
goal round, a resident step — and everything the agent did to answer it. A
delegated agent runs in a child session of its own. The file layout is on
[Session storage](session-storage.md); this page is about identity and
ownership.

## Selecting a Project

The CLI canonicalizes the working directory, resolving symlinks, and turns the
path into a slug by replacing every character outside `[A-Za-z0-9]` with `-`:
`/home/me/src/app` becomes `-home-me-src-app`. The Project's directory is
`<NAMZU_HOME>/projects/<slug>/`.

The first launch in a directory mints the Project id, a UUIDv7, into
`projects/<slug>/project.json` together with the canonical path; every later
launch adopts it. Two launches in a new directory at the same moment end up
with one `project.json`: the one that loses the race reads the winner's file.
If a `project.json` already names a different path (two paths that slug the
same), the Project moves to `<slug>-<first 8 hex of sha256(path)>`. A slug
never looks like a UUID, which is how the CLI tells its own directories from
the `projects/<uuid>/` directories an earlier version wrote.

A moved or renamed checkout has a new path, so it gets a new slug and a new
Project; its old conversations stay under the old slug.

`namzu history --session <id> --cwd <directory>` accepts a conversation UUID
or a host session key and reads that directory's Project. Omitting `--session`
selects the most recent conversation for the directory. The resume picker and
`--continue` list sessions through the session index, scoped to the Project.

Tool execution, project trust and configuration continue to use the selected
working directory. Nothing generated is written under it: `<cwd>/.namzu`
holds only the `agents`, `skills`, `commands`, `plugins` and `MEMORY.md` you
author, and the CLI only reads it.

## Identity and persistence

Generated state lives under `~/.namzu`, or `NAMZU_HOME` when configured:

- `config.yaml`, `credentials.json`, `preferences.json`, `trust.json`,
  `plugin-settings/` and `cli.json` keep their locations. The state inventory
  classifies saved plugin choices as configuration; see [Plugins](plugins.md).
- `index.sqlite` indexes every session log: sessions, turns, child sessions,
  pending decisions, external ids and full-text evidence. It is rebuilt from
  the logs whenever it is missing, out of date or at another version, so
  deleting it loses nothing. See [The session index](../sdk/sqlite-sessions.md).
- `projects/<slug>/<session-id>.jsonl` is a session: one append-only,
  hash-chained log, the source of truth for everything the session did. See
  [Session log](../sdk/session-log.md).
- `projects/<slug>/<session-id>/` holds what belongs to that session: child
  sessions under `subagents/`, checkpoints, the token ledger of each root turn
  under `budgets/`, tasks, message feedback, goals, tool-result spills,
  `/restore` snapshots under `file-history/`, and the writer's `lease.json`.
- `projects/<slug>/memory/` holds stored memories, one Markdown file per
  memory and a generated `MEMORY.md` index (see [Memory](memory.md)).
- `projects/<slug>/residents/<agent>/` holds explicitly created resident state,
  including its learning database; see
  [Durable learning records](../sdk/resident-learning-storage.md).
- `projects/<slug>/worktrees/` holds git worktrees the agent creates.

A session's title, archive flag and desktop window mapping are records in its
log (`session_updated`), so they are rebuilt with the index like everything
else. A desktop key is recorded as an external reference of the session, so two
workspaces can use the same external window key independently.

The CLI requires Node.js 22.13 or newer, and uses `node:sqlite` for the index.

## One turn at a time

A session has at most one active turn. Sending a prompt while the session's
last turn is still running, or is paused on a decision or a provider wait, is
refused rather than interleaved:

- In the TUI the refusal names the turn and offers `/resume`, which continues
  it under the same turn id, or `/abandon`, which closes it so the next prompt
  starts a new turn. A turn left behind by a process that died — interrupted,
  neither running nor paused — is closed as interrupted when you send the next
  prompt.
- `namzu exec`, in either mode, against such a session exits 75 and names
  the turn; see [Exit codes](exec-exit-codes.md) and
  [`exec --json`](exec-json.md).
- Parallel work goes to delegated agents, which run in child sessions, or to
  separate sessions.

### Checkpoints

Every turn the CLI starts keeps its newest 10 checkpoints
(`turnConfig.pruneKeepLast`, `packages/cli/src/integrations/state/retention.ts`).
That includes interactive turns, headless turns, resumed and drained turns,
and turns in delegated child sessions. The kernel's own default keeps all of
them. Nothing in the CLI reads an older checkpoint: every resume reads the
checkpoint it was handed or the newest one. A checkpoint an open decision
references is never pruned, however old. A checkpoint holds no messages; its
context is the session log up to the record it names, so it costs a few
kilobytes of counters and working state.

No crash dumps are written. The session log is appended as the turn goes, and
a torn last line left by a crash is repaired the next time the session is
opened, so an interrupted turn has nothing more to save.

## State an earlier CLI wrote

This is a new storage format, and there is no migration. The CLI does not read,
move or delete anything an earlier version wrote. `namzu state` (report
`version: 2`) lists it under `legacy`: the top-level `state/`, `sessions/`,
`titles.json`, `desktop-sessions.json`, `delegation-history/`, `checkpoints/`,
`tenants/`, `goals/`, `feedback/`, `learning/`, `residents/`, `worktrees/` and
`memory/`, and every `projects/<uuid>/` directory — with paths and sizes, and
without opening any of them. Remove them yourself once you no longer need
them. Old conversations remain readable with the older CLI and its original
application home; export one first with that version's
`namzu history --session <id>`.

Entity IDs are opaque UUIDs. Prefixed IDs are rejected at admission.

## Delegated work

A delegated agent runs in a child session of the invoking session: its log is
`<session-id>/subagents/<child-id>.jsonl`, beside a `<child-id>.meta.json` that
names its parent session, the parent turn whose tool call spawned it, its
root, depth and status. A child's own children nest the same way. The parent
log records `child_session_spawned` and `child_session_ended`, so the parent's
record and the child's agree. Finished children are listed and replayed from
their logs; see [Delegated work](delegated-work.md).

Each parent session gets its own scheduler context, so a conversation change
cannot overwrite another's lineage. The manager enforces live delegation
width; finished children do not consume slots. Excess tasks remain queued with
their own IDs; they reserve budget and start only when admitted, after
rechecking the parent. A turn can only inspect or control tasks its session
owns. Settling or closing a parent releases its scheduler and cancels children
it still owns.

Tasks are durable, under `<session-id>/tasks/`, and each records the turn that
created it. The task context the model sees lists the open tasks from any turn
and those closed in the current turn; see [Task context](task-context.md).

`namzu drain` continues parked turns another process left behind; see
[`namzu drain`](drain.md). A resumed turn keeps its root turn's token ledger:
resuming does not grant a fresh allowance. Checkpoint recovery preserves
[unknown tool outcomes](../sdk/tool-execution.md#recovery-after-an-interrupted-effect)
instead of automatically repeating actions without a recorded completion.
