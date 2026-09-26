---
type: Reference
title: Session storage
description: Every file the CLI keeps under NAMZU_HOME — the per-project directory, the one log per session, what sits beside it, the rebuildable index and the scratch directory — and which of them are safe to delete.
resource: packages/sdk/src/session/paths.ts
tags: [cli, storage, sessions, layout]
status: stable
generated: { by: process:claude-code, at: 2026-09-21T00:00:00Z }
---

# Session storage

The CLI and the SDK share one layout under the application home, `~/.namzu`
(or `NAMZU_HOME`). The layout is computed in one place, `SessionPaths`
(`packages/sdk/src/session/paths.ts`), which also checks every id before it
becomes a path segment. [Project and session state](project-state.md) says how
a working directory picks its project; this page says what is on disk.

```text
~/.namzu/
├── config.yaml, credentials.json, preferences.json, trust.json, cli.json, plugin-settings/
├── attachments/, skills/, agents/, commands/, plugins/, MEMORY.md
├── index.sqlite                      rebuildable index over every session log
├── cli/zen-catalogue.json            last-good Zen model catalogue (background refresh)
├── schedule/                         scheduled jobs and their scheduler (see Scheduled tasks)
│   ├── jobs/<job-id>.json            job definitions; jobs/.revisions/ holds compare-and-set markers
│   ├── state/<job-id>.json           what the scheduler remembers between evaluations
│   ├── claims/<job-id>/<key>.json    one per occurrence ever started, published with link
│   ├── history/<job-id>.jsonl        runs, skips, missed occurrences and job changes
│   ├── runs/<job-id>/<run-id>.json   each run's result; <run-id>.log beside it is the run's output
│   ├── daemon/                       lease.<fence>.json, lease.json, endpoint.json, heartbeat.json, notify.json, stop.json, log/
│   ├── daemon.env                    optional KEY=value credentials for scheduled runs (0600)
│   ├── service.json                  what `namzu schedule install` created
│   └── seen.json                     when the TUI last summarised scheduled runs
└── projects/
    └── <slug>/                       one per working directory
        ├── project.json              {"v":1,"kind":"project","projectId","cwd","slug","createdAt"}
        ├── memory/                   stored memories + MEMORY.md index
        ├── residents/<agent-key>/    resident state, learning.sqlite, artifacts/
        ├── worktrees/<label>/        git worktrees the agent creates
        ├── <session-id>.jsonl        the session log
        └── <session-id>/
            ├── subagents/            <child-id>.jsonl, <child-id>.meta.json, <child-id>/subagents/…
            ├── tool-results/         spilled tool output and large record bodies
            ├── checkpoints/          <checkpoint-id>.json
            ├── budgets/              <root-turn-id>.json (root sessions only)
            ├── tasks/                <task-id>.json
            ├── feedback/             <message-id>.json and .revisions/
            ├── goals/                <goal-id>.json
            ├── file-history/         /restore snapshots
            └── lease.json            which process may write the log (beside lease.<fence>.json)
```

A temporary scratch directory per session lives outside the home, at
`$TMPDIR/namzu-<user>/<slug>/<session-id>/scratchpad/`. On POSIX it is created
with mode 0700 and refused if it is a symlink or owned by another user.

## What each piece is

| Path | What it is | Safe to delete? |
|---|---|---|
| `<session-id>.jsonl` | The whole conversation and everything done in it: prompts, messages, tool calls, decisions, compactions, audit entries, each line hash-chained to the one before. The source of truth. | Deleting it deletes the conversation. |
| `<session-id>/subagents/` | Child sessions of delegated agents, one log each, recursively. The `.meta.json` beside each is a convenience; the child's log wins on any disagreement. | Only with the parent. |
| `<session-id>/checkpoints/` | Resume points, each committed by a record in the log. The CLI keeps each turn's newest 10. | Deleting one makes that point unresumable; the log is unaffected. |
| `<session-id>/budgets/` | The token ledger of each root turn and the child sessions it spawned. | Only for a turn that will not be resumed. |
| `<session-id>/tool-results/` | Bodies too large for one log record, each with a manifest; the record names the file and its hash. | No: the record that points at it becomes unreadable. |
| `<session-id>/tasks/`, `goals/`, `feedback/` | Durable task list, goals and message feedback for the session. | Deleting loses them. |
| `<session-id>/file-history/` | Copies of files taken before a tool changed them, for `/restore`. | Deleting disables `/restore` for that session. |
| `<session-id>/lease.json` | The current writer's claim and fencing token. A process stopped by SIGTERM, SIGHUP or SIGINT releases it before it exits; one killed outright (SIGKILL, a crash) holds it until it expires, at most five minutes, and then it is taken over, so a session is never locked for good. | Not while a process is using the session. |
| `<session-id>/lease.<fence>.json` | One file per claim, named by its fencing token; the highest is the current holding, and `lease.json` is a readable copy of it. A release writes the next fence with an empty holder. Older holdings are pruned, so a few remain. A child session has its own under `subagents/<child-id>/`. | No: the highest fence is what decides who may write. |
| `index.sqlite` | Sessions, turns, child sessions, pending decisions, external ids and full-text search, all derived from the logs. | Yes. It is rebuilt on the next launch. |
| `cli/zen-catalogue.json` | The last Zen and Zen Go model catalogue a launch's background refresh derived and validated; see [The model catalogue refresh](model-catalogue.md). | Yes. The next launch uses the bundled catalogue until its refresh lands and writes a new one. |
| `project.json` | The project's id and canonical path. | Deleting it gives the directory a new project id on the next launch. |
| `schedule/jobs/` | Scheduled job definitions. Run sessions live under `projects/<slug>/` like any other, titled `⏲ <job> · <time>`. | Deleting a file deletes the job; `namzu schedule remove` is the way. |
| `schedule/history/`, `schedule/runs/`, `schedule/daemon/log/` | Records and output of past runs, and the scheduler's log. | Yes. |
| `schedule/claims/` | Which occurrences already started. | Only while the scheduler is stopped: deleting one while it runs can re-run an occurrence after a backward clock jump inside the catch-up window. |
| `schedule/state/` | The scheduler's memory of each job. | Only while the scheduler is stopped; it is rebuilt, and occurrences within the catch-up window may then be caught up again. |
| Old run sessions | The scheduler **archives** (never deletes) a job's completed-run sessions beyond its newest `retention.keepSessions` (default 20), so `/resume` stays usable. | `namzu schedule prune --delete` deletes old runs and their sessions after listing them, a removed job's included, and a removed job's history once none of its runs is left. |

## Why one log per session

Everything a session did is appended to one file as it happens, so there is
one place to read, one thing to back up, and nothing to reconcile after a
crash: a torn last line is truncated on the next open and a `log_repaired`
record says so. Each line carries the hash of the one before it, so an edited
or truncated log is detected rather than misread. The index, the checkpoints
and the meta files are all checked against the log or rebuilt from it.

`namzu history` and the resume picker show a conversation as the fold of its
log: the latest compaction's summary, the messages after it, and every
replacement applied. An answer rewritten by a guardrail or review is shown
rewritten; the raw text stays in the log for audit only.

## Archived conversations

`/archive` asks before archiving the current conversation and exiting. Its
history stays in the same session log, but it disappears from `/resume` and
cannot start another turn. The CLI refuses to archive a conversation with an
open turn, including one paused for a decision. Archiving and restoring each
hold that conversation's writer lease, so concurrent operations cannot both
publish a change from the same state.

Older Namzu versions could archive a conversation whose turn was still open.
Restoring that conversation is permitted; its turn remains paused or
interrupted until you explicitly resume or abandon it.

Use `/unarchive` to choose one of this project's most recent 100 archived
conversations, restore it and open it. From a shell, `namzu archive list` shows
the first 100, `namzu archive list --page 2` shows the next 100, and
`namzu archive restore <conversation-id>` restores an exact id. Then run
`namzu resume <conversation-id>` in the same project. An empty archived
conversation still appears in the archive list, but has no messages to resume.
Neither command looks in another project's logs.
On runtimes using the in-memory session index, opening the archived list checks
this project's root logs for changes made by another Namzu process. A TUI
opened before that process archived the conversation still finds it.

The latest `session_updated.archived` record is authoritative. Restoring
appends `archived: false`; deleting and rebuilding `index.sqlite` preserves the
result. If the index cannot refresh after that durable append, Namzu says that
the log changed and asks for a restart to rebuild the list instead of claiming
the restore failed without changing anything.

## What is never written

- Nothing under the working directory. `<cwd>/.namzu` is read for the files you
  author there and never written.
- No crash dumps, no per-run directories, no `sessions.sqlite`, no
  `transcript.jsonl`, `messages.json` or `report.md`. An earlier CLI wrote
  those; `namzu state` reports what is left of them as `legacy`, and this
  version never reads them.
