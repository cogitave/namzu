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
goal round — and everything the agent did to answer it. A
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

Each [managed Git worktree](worktrees.md) is also a separate checkout and
Project. `namzu worktree fork` copies a settled conversation into the new
Project when you want its history there.

`namzu history --session <id> --cwd <directory>` accepts a conversation UUID
or a host session key and reads that directory's Project. Omitting `--session`
selects the most recent conversation for the directory. The resume picker and
`--continue` list sessions through the session index, scoped to the Project.

Tool execution, project trust and configuration continue to use the selected
working directory. Conversations, checkpoints, file copies, memory and the
index never go under it. `<cwd>/.namzu` holds the `agents`, `skills`,
`commands`, `plugins`, `MEMORY.md` and `settings.json` you author, which the
CLI reads. The CLI writes there only when you ask: the project's local
settings file `settings.local.json` (this computer's settings for the folder,
where a "don't ask again" answer and a `/permissions add` rule are saved, with
its `.lock` and `.tmp` files while a save runs), a skill you save with
`save_skill` (into `.namzu/skills`), and the workflows `namzu github install`
adds. Namzu keeps the local settings file out of git with a
`**/.namzu/settings.local.json*` line in your global git ignore file, the one
write outside both the folder and the Namzu home. An earlier CLI kept that file
as `namzu.config.local.json` at the top of the folder; a session in the trusted
folder moves it ([Permission layers](permission-layers.md#moving-the-earlier-file)).
Crash logs go to `~/.namzu/logs`.

## Identity and persistence

Generated state lives under `~/.namzu`, or `NAMZU_HOME` when configured:

- `config.yaml`, `credentials.json`, `preferences.json`, `trust.json`,
  `plugin-settings/` and `cli.json` keep their locations. The state inventory
  classifies saved plugin choices as configuration; see [Plugins](plugins.md).
- `network/` holds your Namzu network's per-machine state (mode 0700, files 0600): the machine key and certificate, membership, last addresses, roles, an audit log, and the leader and control files. Nothing is created until the network runs. See [Your Namzu network](namzu-network.md#what-is-on-the-network-and-what-is-on-disk).
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
- `projects/<slug>/learning/` holds what the project learned: the observations
  its conversations kept, its guidance (`session-guidance/`) and one directory
  per named learning target under `targets/<name>/` (`store/` with the learning
  database, `guidance/`); see [Learning in the CLI](learning.md) and
  [Durable learning records](../sdk/learning-storage.md). A `residents/<agent>/`
  directory an earlier version made is left as it is; what learning kept in it
  is copied into `learning/` the first time it is used.
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

No conversation dump is written. The session log is appended as the turn goes, and
a torn last line left by a crash is repaired the next time the session is
opened, so an interrupted turn has nothing more to save.

## State an earlier CLI wrote

This is a new storage format, and there is no migration: the CLI does not read
anything an earlier version wrote. `namzu state` (report `version: 2`) lists it
under `legacy`, with paths and sizes and without opening any of it. Old
conversations remain readable with the older CLI and its original application
home; export one first with that version's `namzu history --session <id>`.

In the Namzu home the old layout is the top-level `state/`, `sessions/`,
`titles.json`, `desktop-sessions.json`, `delegation-history/`, `checkpoints/`,
`tenants/`, `goals/`, `feedback/`, `learning/`, `residents/`, `worktrees/` and
`memory/` (except `memory/curation.jsonl`, which is current), and every
`projects/<uuid>/` directory. Remove them yourself once you no longer need them.

### In a project folder

An earlier CLI also kept state inside the project's own `.namzu`: a `cli.json`
pointer and `projects/<id>/` until state moved to the Namzu home, and before
that the whole layout above. In a project's `.namzu` (when it is not also the
Namzu home), every name an earlier version wrote there counts as `legacy`:
the names above, `cli.json`, `cli/`, `projects/`, `attachments/`,
`index.sqlite` and its journal files, and the per-machine files that sat beside
them (`config.yaml`, `credentials.json`, `identity.json`, `preferences.json`,
`plugin-settings/`, `trust.json`). What you author there (`agents`, `skills`,
`commands`, `plugins`, `rules`, `MEMORY.md`) and the settings files are not;
a name no version wrote is yours and is counted as `unknown`.

Because that state sits in the checkout, a session in a trusted git checkout
keeps git from listing it: the first time it finds such a name, it appends one
block to the clone's own exclude file (the `info/exclude` git names, never your
`.gitignore`), anchored to this folder, headed
`# namzu: state an earlier Namzu kept in /.namzu/ ...`, and says so once. A
file git already tracks is not affected by it (git still lists it). Nothing is
written when that `.namzu` is itself the live Namzu home.

`namzu state move legacy` moves it out, when you ask. It runs only in a folder
you trust and moves only the names above, into
`<NAMZU_HOME>/legacy/<slug>/<time>/` beside an `origin.json` that names the
folder they came from. On one file system each entry is renamed; across file
systems it is copied, flushed, put in place and compared file by file with the
original, and the original is removed only when they match (otherwise both are
kept and the command says so; folder modes and times are copied too). It leaves in place, with the reason: anything
git tracks (take it out of git first), a registered git worktree that has
changes or is locked (a clean one is moved with `git worktree move`, so git
keeps track of it), a folder holding a worktree deeper down, and everything
when git cannot say what it tracks. One move runs per folder at a time.
`namzu state move legacy --dry-run` lists what would move and changes nothing.
The old spelling `namzu state move-legacy` no longer runs: it prints one line naming `namzu state move legacy` and exits 64. Namzu does not read the moved files either; delete the folder when you no
longer want them. `namzu state` counts that `legacy/` folder in the home as
`legacy`.

One file is moved: the project's `namzu.config.local.json`, the folder's local
settings an earlier CLI kept at the top of the folder. A session in the trusted
folder copies its bytes into `.namzu/settings.local.json`, reads the copy back,
keeps the same bytes in the Namzu home as
`backups/projects/<folder>/namzu.config.local.json.backup.<ms>`, and only then
removes the old file, and never one git tracks
([Moving the earlier file](permission-layers.md#moving-the-earlier-file)).
Until then it is still read, and `namzu state` names it ("Earlier local
settings file") with its size.

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
