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

An owned Pal keeps the exact workspace spelling from its approved profile in
conversation ownership and journal headers. On Windows, asynchronous native
path resolution can return different letter casing for that same directory.
The CLI accepts that difference only after checking the prepared project and
the current profile against the original directory's device, inode and birth
time, rejecting symbolic links, replacement and deletion during preparation.
The project document, id and slug retain their canonical identity; ordinary
project scopes are unchanged. Existing Pal profiles and journals are not
rewritten.

```text
~/.namzu/
├── config.yaml, credentials.json, preferences.json, trust.json, cli.json, plugin-settings/
├── accounts.json, mcp-approvals.json, tip-history.json, hint-counts.json
├── backups/                          recovery copies: <file>.backup.<ms>, <file>.corrupted.<ms>
├── attachments/, skills/, agents/, commands/, plugins/, MEMORY.md
├── index.sqlite                      rebuildable index over every session log
├── cli/zen-catalogue.json            last-good Zen model catalogue (background refresh)
├── schedule/                         scheduled jobs and their scheduler (see Scheduled tasks)
│   ├── jobs/<job-id>.json            job definitions; jobs/.revisions/ holds compare-and-set markers
│   ├── state/<job-id>.json           what the scheduler remembers between evaluations
│   ├── script-state/<job-id>.json    last committed state of a reporting script
│   ├── deliveries/<session-id>/     source-conversation notices, one immutable file per result
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
        ├── learning/                 observations, guidance, targets/<name>/{store,guidance}
        ├── worktrees/<label>/        git worktrees the agent creates
        ├── <session-id>.jsonl        the session log
        └── <session-id>/
            ├── subagents/            <child-id>.jsonl, <child-id>.meta.json, <child-id>/subagents/…
            ├── tool-results/         spilled tool output and large record bodies
            ├── checkpoints/          <checkpoint-id>.json
            ├── budgets/              <root-turn-id>.json (root sessions only)
            ├── tasks/                <task-id>.json
            ├── plans/                plan.md, the one file plan mode may write
            ├── feedback/             <message-id>.json and .revisions/
            ├── goals/                <goal-id>.json
            ├── file-history/         /restore snapshots
            └── lease.json            which process may write the log (beside lease.<fence>.json)
```

A temporary scratch directory per session lives outside the home, at
`<temp base>/namzu-<user>/<slug>/<session-id>/scratchpad/`. Every session that runs
commands on this machine has one, an ephemeral `exec` run included: it is created
when the first turn starts, with mode 0700, and refused if it is a symlink or owned by
another user. A sub-agent uses its parent's. Nothing removes it when the process ends; the
operating system clears it with the rest of its temporary files. Background job output
files are in its `jobs/` folder ([Where files go](where-files-go.md)).
For a confirmed no-project script job, a separate private working directory
is created beside `NAMZU_HOME`, under `<NAMZU_HOME>-schedule-workspaces/<job-id>/`.
It is not a session or a filesystem sandbox.

### Where scratch files go

Everything Namzu writes to a temporary place (the shell's directory marker, rendered PDF pages, a
pasted image, the external editor's draft, the update download, the sandbox's own working directory,
the port-forward files of a local Pal computer) goes under one private folder,
`<temp base>/namzu-<user>/`. The base is `NAMZU_TMPDIR` when it is set to a full path, otherwise the
operating system's temporary folder (`TMPDIR`, `TMP` or `TEMP`). The folder is created with mode 0700
and refused when it is a symbolic link, not a folder, owned by someone else or open to other users;
there is no fallback to another place. When it cannot be created, Namzu says so in one line that names
the folder and the cause, for example "The disk is full, so Namzu could not create /tmp/namzu-1000. Free
some space and start again, or set NAMZU_TMPDIR to a folder on another disk.", and exits with status 69
at start-up. The same sentence form covers a used-up quota ("Your disk quota is used up") and a folder
that cannot be written to (it names `NAMZU_TMPDIR`). A full disk under `NAMZU_HOME` is reported the same
way, naming `NAMZU_HOME`. `namzu doctor` checks the base and the private folder.

Two places deliberately keep the operating system's folder: the runtime directory for peer sockets
(its last candidate, because a long `NAMZU_TMPDIR` can exceed the socket-path limit; see
[Peer messaging](../sdk/peer-messaging.md#the-runtime-directory)), and a computer-use screenshot on macOS,
which a separate package writes and which does not depend on the newest kernel.

When the disk fills while a session runs, the session keeps going and says so once; see
[Session log](../sdk/session-log.md#a-volume-that-stops-accepting-writes).

## What each piece is

| Path | What it is | Safe to delete? |
|---|---|---|
| `<session-id>.jsonl` | The whole conversation and everything done in it: prompts, messages, tool calls, decisions, compactions, audit entries, each line hash-chained to the one before. The source of truth. | Deleting it deletes the conversation. |
| `<session-id>/subagents/` | Child sessions of delegated agents, one log each, recursively. The `.meta.json` beside each is a convenience; the child's log wins on any disagreement. | Only with the parent. |
| `<session-id>/checkpoints/` | Resume points, each committed by a record in the log. The CLI keeps each turn's newest 10. | Deleting one makes that point unresumable; the log is unaffected. |
| `<session-id>/budgets/` | The token ledger of each root turn and the child sessions it spawned. | Only for a turn that will not be resumed. |
| `<session-id>/tool-results/` | Bodies too large for one log record, each with a manifest; the record names the file and its hash. | No: the record that points at it becomes unreadable. |
| `<session-id>/plans/plan.md` | The plan the model wrote in plan mode, kept after it is approved. See [Plan mode](plan-mode.md). | Deleting loses the plan; the conversation shows it as approved. |
| `<session-id>/tasks/`, `goals/`, `feedback/` | Durable task list, goals and message feedback for the session. | Deleting loses them. |
| `<session-id>/file-history/` | Copies of files taken before a tool changed them, for `/restore`. | Deleting disables `/restore` for that session. |
| `<session-id>/lease.json` | The current writer's claim and fencing token. A process stopped by SIGTERM, SIGHUP or SIGINT releases it before it exits; one killed outright (SIGKILL, a crash) holds it until it expires, at most five minutes, and then it is taken over, so a session is never locked for good. | Not while a process is using the session. |
| `<session-id>/lease.<fence>.json` | One file per claim, named by its fencing token; the highest is the current holding, and `lease.json` is a readable copy of it. A release writes the next fence with an empty holder. Older holdings are pruned, so a few remain. A child session has its own under `subagents/<child-id>/`. | No: the highest fence is what decides who may write. |
| `backups/` | Recovery copies of the state files below: each file as it was before a change, and any that could not be read. See [State files several processes change](#state-files-several-processes-change). | Yes, but then there is nothing to go back to. |
| `index.sqlite` | Sessions, turns, child sessions, pending decisions, external ids and full-text search, all derived from the logs. | Yes. It is rebuilt on the next launch. |
| `cli/zen-catalogue.json` | The last Zen and Zen Go model catalogue a launch's background refresh derived and validated; see [The model catalogue refresh](model-catalogue.md). | Yes. The next launch uses the bundled catalogue until its refresh lands and writes a new one. |
| `project.json` | The project's id and canonical path. | Deleting it gives the directory a new project id on the next launch. |
| `schedule/jobs/` | Scheduled job definitions. Run sessions live under `projects/<slug>/` like any other, titled `Scheduled: <job> · <time>`. | Deleting a file deletes the job; `namzu schedule remove` is the way. |
| `schedule/deliveries/` | Durable notices returned to the exact conversation that proposed a job. They are displayed by the TUI but never appended as model messages. | No, unless losing those notices is intended. |
| `schedule/script-state/` | Last committed opaque state for jobs using the JSON script report. The scheduler advances it only after the run result is settled. | No; deleting it makes the next script poll start from empty state. |
| `schedule/history/`, `schedule/runs/`, `schedule/daemon/log/` | Records and output of past runs, and the scheduler's log. | Yes. |
| `schedule/claims/` | Which occurrences already started. | Only while the scheduler is stopped: deleting one while it runs can re-run an occurrence after a backward clock jump inside the catch-up window. |
| `schedule/state/` | The scheduler's memory of each job, including source results still awaiting delivery. | Only while the scheduler is stopped and no delivery is pending; occurrences within the catch-up window may then be caught up again. |
| Old run sessions | The scheduler **archives** (never deletes) a job's completed-run sessions beyond its newest `retention.keepSessions` (default 20), so `/resume` stays usable. | `namzu schedule prune --delete` deletes old runs and their sessions after listing them, a removed job's included, and a removed job's history once none of its runs is left. |

## State files several processes change

The terminal, the Desktop engine and `exec` can all run at once, and Desktop itself
writes the trusted folders list, so a few small files in the Namzu home are changed
by more than one process. Each change to them holds a lock file beside the file,
`<file>.lock`, reads the file again under it, makes its one change, and writes the
whole file through a temporary file that is flushed to disk before it is renamed
over the old one. Two processes that change the same file at the same moment both
keep their change. The lock is the SDK's
[state file lock](../sdk/state-files.md#the-lock). The next change takes over a lock
left by a process that has exited, a lock that never got its owner written into it
(the disk was full, or the process was killed right after creating it) once it is ten
seconds old, and a lock that carries the pid of the process now running but was left
by an earlier one (as after a container restart). A process that finds the lock held
by a live process waits up to about two seconds and then refuses with "... is being
saved by another Namzu process right now, so this change was not made. Try again in a
moment."

| File | Locked | Recovery copy before a change | A file that cannot be read |
|---|---|---|---|
| `config.yaml` | yes, one lock across a whole Settings save, a `namzu mcp add` and a server edit | yes | refused, as before ("... is not valid YAML ...; fix it first."), now naming the newest recovery copy |
| `trust.json` | yes, also by Desktop's **Remove** and **Start a new list** | yes | trusts nothing; a change is refused and the file kept (below) |
| `mcp-approvals.json` | yes | yes | approves nothing; a change is refused and the file kept (below) |
| `accounts.json` | yes (as before) | yes; a removed API key is cut out of every copy | refused, as before, now naming the newest recovery copy |
| `account-activity.json`, `terminal-state.json` | yes (as before) | no | read as empty |
| `preferences.json` | written whole | yes | "needs re-pick", as before |
| `tip-history.json`, `hint-counts.json` | yes, for a short wait; a count that cannot get the lock is dropped | no | read as empty |

Recovery copies are in `backups/` in the Namzu home, named
`<file>.backup.<epoch ms>`: the file as it was just before a change, at most one a
minute per file, the newest five kept, none taken when it would equal the newest or
when the file is empty. A copy is therefore the file before the change it was taken
for: that change, and any made in the minute after it, are not in it. The number in
the name only grows, also after the computer's clock went back, so the highest number
is always the newest copy; the copy's modification time is when it was taken. Every
copy is mode 0600, also of a file that was wider, because some of these files hold
keys. `credentials.json`, `api-keys.json` and `gemini-api-key.json` get no copy on
purpose: they hold sign-in tokens and keys that signing in again or pasting the key
replaces, and an old copy would keep a revoked one on disk. A tool server's headers
and environment in `config.yaml` can hold tokens too: `namzu mcp remove` cuts the
server out of every `config.yaml` copy, but a header or environment value you change
stays in the copies taken before the change until five newer copies replace them.

A `trust.json` or `mcp-approvals.json` that exists but is not valid JSON, is not the
expected shape, or carries a newer `version` used to read as empty, and the next grant
replaced it with a file holding only that grant. Now:

- Reading it trusts nothing and approves nothing, so no folder or server is let in by
  a damaged file. A file that is empty or holds only blank space has nothing to keep
  and reads as no file at all.
- A change is refused. The file's bytes are copied first to
  `backups/<file>.corrupted.<epoch ms>` (once per distinct content), and the refusal
  says so in one sentence that names the file, the copy and the newest `.backup.` copy,
  for example "~/.namzu/trust.json could not be read (not valid JSON), so it was not
  changed. Its contents are kept in ~/.namzu/backups/trust.json.corrupted.&lt;ms&gt;. The
  newest recovery copy is ~/.namzu/backups/trust.json.backup.&lt;ms&gt;, the file as it was
  before a change at 2026-11-21 16:03; that change and any later one are not in it. To
  go back to it, copy it over ~/.namzu/trust.json. Fix or remove the file, then try
  again."
- In the terminal the trust box says the list could not be read, that a yes holds for
  this session only, and offers **s start a new list with this folder**. `namzu exec`
  refuses with a line that names the list instead of "a folder nobody has trusted".
  Creating a Pal is refused before anything is made. In Desktop, trusting a folder is
  refused with a sentence that points to **Settings, Trusted folders, Start a new
  list**. For `mcp-approvals.json` the refusal names `namzu mcp approve --new-list`.
- Starting a new list keeps the old file in `backups/<file>.corrupted.<epoch ms>`,
  reads the copy back and compares it, and only then writes the new list (the folder
  being trusted, an empty Desktop list, or the approvals being given). If the copy
  cannot be made or the file changes meanwhile, nothing is replaced. A list that
  reads again by then is not replaced.
- Entries this version does not understand (a list entry that is not text, a key a
  newer writer added, another folder's odd answer) are kept as written when the file is
  changed.

`namzu doctor` has a `runtime.state-files` line. It fails, naming the file and the
reason, when `trust.json` or `mcp-approvals.json` cannot be read, or when a lock file
at the top of the Namzu home cannot be read (nothing can take that one over: close
Namzu and remove it). It warns, naming each one, about a lock left by a process that
has exited or never given an owner, which the next change takes over. Otherwise it
says where the recovery copies are and which files they cover.

Nothing is restored on its own. To go back to a copy, close Namzu (the terminal and
Desktop) and copy the newest `<file>.backup.<epoch ms>` over the file, for example
`cp ~/.namzu/backups/trust.json.backup.<epoch ms> ~/.namzu/trust.json`. To start a new
list instead, use the trust box's **s**, Desktop's **Start a new list** or
`namzu mcp approve --new-list`; removing the file by hand works too, since its damaged
bytes are already in `backups/` once a change was refused.

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

Desktop history reads the same folded journal. For an ordinary conversation,
it retains a commentary or final-answer display phase only when the stored
public text parts unambiguously carry that phase and still exactly select the
folded message content. This keeps recorded progress commentary in the work
details after reopening. An unphased message or a revised message whose parts
no longer match its selected content has no inferred phase. Pal history keeps
its separate public-reply filter and omits commentary. A Pal reply whose exact
folded message still matches a durable `message_completed` event with
`stopReason: cancelled` is also omitted after reopening. A completed earlier
reply, a later revision, or a legacy message without that event remains
visible. These display rows do not change the journal or model replay, and
cold history does not reconstruct tool receipts or reasoning.

## Archiving idle conversations

`archiveInactive` (Settings, Projects, *Archive inactive conversations*) is `never` by default, or `1d`, `7d`
or `30d`. The desktop host reads it from your own file and the managed file each time it lists a project's
conversations, and archives each one whose last activity is at least that old, through the same
`namzu/conversations/archive` route and the same gates: a conversation with an open turn, one with running
background work, and one in a folder that is not trusted are never archived (they are tried again on a later
listing, but not within ten minutes of a refusal). A listing looks at up to 2000 conversations, archives the
longest idle first, and archives at most five each time, so a project with a long backlog catches up over a few
listings while the list shown stays at the 100 newest. Archiving only moves a conversation to the archive, where it stays readable and can be restored; it
never deletes a conversation and it never touches a worktree, so a worktree with uncommitted changes stays on
disk. The terminal app has no sweep of its own: the setting is applied where the conversation list is drawn by
the desktop app.

When the app asks for it (`idleArchivedRows: true` in the request), the listing names each conversation it
archived (an extra row `{ id, idleArchived: true }`); an app that does not ask gets no such rows. The desktop
app asks, and drops its row for it the way it drops one a person archived, including a row the window still held open;
the conversation is then in the archive list and can be restored.

## Archived conversations

`/archive` asks before archiving the current conversation and exiting. Its
history stays in the same session log, but it disappears from `/resume` and
cannot start another turn. The CLI refuses to archive a conversation with an
open turn, including one paused for a decision. Archiving and restoring each
hold that conversation's writer lease, so concurrent operations cannot both
publish a change from the same state.

The desktop host exposes `namzu/conversations/archive` with exactly one
`sessionId`. It uses the same scoped journal and writer checks, also refusing
running or unresolved background work. A durable success returns
`{ sessionId, archived: true }`; retrying an already archived conversation
still checks its writer lease. This removes the conversation from the active
list without deleting its history, files, or child sessions.

An owned native engine can retain its writer after a turn finishes. The desktop
host closes only that exact idle connection before strict archival, checking
the captured home, project, tenant and execution directory first. Its archive
reservation prevents another prompt or engine/model change until the operation
settles. A waiting turn, unresolved native state or background work refuses this
cleanup; a failed close retains its owner and writer for retry. Embedded runtimes
without this optional reservation keep the existing strict writer gate.

When the selected project's strict journal is physically absent, the endpoint
returns `{ sessionId, archived: false, missing: true }`. This is evidence of
absence in that captured home and project, not an archive or authorization to
remove another conversation. A host may use it only to discard its own known,
never-prompted local projection after checking any runtime alias. Present
foreign, corrupt, and open-turn journals fail instead of returning this receipt.

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
