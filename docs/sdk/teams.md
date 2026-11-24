---
type: Reference
title: Teams (SDK)
description: The membership file, member names, mailboxes and orphan sweep that teammates stand on, with the locking rules, the files and the limits; the runner that starts teammates is not part of this page yet.
resource: packages/sdk/src/teams/
tags: [sdk, teams, teammates, mailbox, experimental]
status: draft
generated: { by: "claude-sonnet-5", at: "2026-11-24" }
---

# Teams (SDK)

`@namzu/sdk`'s `teams/` module (every export `@experimental`) is the storage and naming layer for teammates: named helpers that keep their own conversation beside the main one and message each other. It holds who is in a team and what mail each member has. It does not start a teammate; that is the host's job, behind the `TeammateBackend` interface in the same module. Teammates are off by default; see [Teammates](../cli/teams.md) for how a person turns them on.

## Files

Everything lives under `<NAMZU_HOME>/teams/<team>/`, created private to the user (`0700` directories, `0600` files).

| File | What it holds |
| --- | --- |
| `config.json` | `{ version, name, leadSessionId, leadPid?, project?, cwd?, createdAt, members }`. Each member is `{ id, name, color, joinedAt, backend, active, agentType? }`. |
| `inboxes/<name>.json` | One mailbox per member, and one for `lead`: a JSON array of `{ id, from, text, summary?, at, read?, kind? }`. The file name is the member's name folded to lower case. |

`backend` is `in-process`, `process` or `pane`; only the first exists so far. `kind` is one of `message`, `idle`, `shutdown_request`, `shutdown_response`, `plan_request`, `plan_response`, `permission_request`, `permission_response`. `active` means the member holds a place in the team: it is set when the name is reserved and cleared when the teammate ends.

## Names

A team name and a member name start with a letter or digit and contain only letters, digits, `_` and `-`, at most 64 characters (a name is also a file name). `lead`, `main`, `team-lead`, `user` and `system` are reserved, and so is anything shaped like a task id or a workflow run id. Two spellings that differ only by case, width or spaces are the same name. `teammateNameProblem` and `teamNameProblem` return the reason in words for the model, or `undefined`.

## Changing the files from more than one process

Other processes read and change the same files: a second terminal, Desktop, and later a teammate in its own process.

- `config.json` is changed only through `TeamStore`, which takes the lock file beside it (the shared lock-file protocol of `utils/file-lock.ts`, retried up to 100 times with a 5 to 100 ms random wait), reads the file, changes it and publishes by rename. A reader sees the old file or the new one, never half of one. A lock whose owner has exited is taken over at once; a lock held past the retries is a `busy` error.
- `reserveMember` writes the name into the file first. Two processes asking for one name: exactly one gets it, the other gets `name_taken`. `rollbackMember(team, id)` removes exactly the member with that id, so a start that failed gives its name back without touching a later member that took the same name; `withReservedMember` does both around a start function.
- `appendMail` creates the mailbox create-exclusive, then reads it, adds the entry and replaces the file by rename under the mailbox's own lock. Appends from many processes are all kept. An entry that does not match the schema is dropped on read and on the next rewrite; a file that is not a JSON array reads as empty. A mailbox keeps at most 500 entries (read ones go first) and one entry carries at most 64 KiB of text. `drainMail` takes the unread entries and marks them read in one step, so none is handed out twice; `pruneMail` drops invalid entries and all but the newest read ones.
- Writes to a team that was removed are refused with `team_not_found`, and the refusal does not bring the directory back.

## The shared task list

`FileTaskStore` keeps one task list that several processes (two terminals, Desktop, a later process backend) change at once, at `<NAMZU_HOME>/tasks/<list id>/`. The list id is the team name when the list belongs to a team, else the session id; it is letters, digits, `_`, `-` and `.`. Each task is one JSON file named by its id. `.highwatermark` issues every task its place in the list (`seq`), so the order of a list, and "the lowest task", never changes and a place is never handed out twice, not even after the task is deleted or the mark is lost (it is raised again from what is on disk). Task ids are the usual entity ids, not the places.

Every change runs under lock files (the shared `file-lock` protocol: created exclusively, owner pid recorded, taken over when the owner has exited). The order is fixed, the list lock first and then task locks in sorted id order, so two changes cannot wait on each other. `DiskTaskStore`, the per-session store, is unchanged and still guards with in-process locks only.

- `claimTask(id, owner)` answers `{ ok: true, task }` or `{ ok: false, code }` with `not_found`, `already_claimed` (another owner), `already_resolved` (completed or failed) or `blocked` (with the blockers not completed). A claim sets the owner and `in_progress`; the same owner claiming again changes nothing. `claim` keeps the `TaskStore` shape (the task or `undefined`).
- A task is blocked only while a blocker is not completed, so completing a blocker unblocks its dependents with no write. A failed blocker keeps its dependents waiting (nothing downstream should run on work that did not happen); deleting a task removes its edges, which unblocks them.
- `block` keeps both directions (`blocks` and `blockedBy`), ignores a repeated edge, and refuses a cycle (a task that already waits on the other, directly or through other tasks, or on itself) with a `TaskListError` of code `cycle`.
- `nextClaimable()` is the lowest pending, unowned, unblocked task, which is what an idle member takes next.
- `reset()` empties the list only when every task is completed (`not_all_completed` otherwise); the mark stays.
- Events (`task.created`, `task.claimed`, `task.updated`, `task.deleted`) reach listeners of the process that made the change.

The task tools use it when they are built over it (`buildTaskTools(store, { member })`): `task_get` is added (a task in full, with what it waits on), `task_update` to `in_progress` claims under the member name and says why a claim failed, a refused dependency is a plain refusal, and `task_list` shows every task of the list, not only the current turn. Over any other store the tools are exactly as before. In the CLI, `SubagentRuntimeOptions.childTaskStore` hands a list to the children of a turn; no host sets it yet.

## Removing teams

`deleteTeam` removes a team's directory (never through a symlink). `sweepOrphans` removes the directories of teams whose lead process no longer exists, and directories with no readable config more than a minute after their last change (so one being created is left alone); a team that records no lead process is never removed by it. Tasks and transcripts live elsewhere and are not touched.

## What is not here yet

The runner that starts a teammate inside the lead's process, `send_message` to a teammate, the use of the task list by teammates and the permission and plan routing are later pieces, each described on its own page when it lands. A separate-process or pane backend is deferred; `TeammateBackend` (`start`, `send`, `stop`, `isAlive`) is the seam it will use.
