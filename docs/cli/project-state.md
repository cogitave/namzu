---
type: Reference
title: Project and session state
description: How the CLI maps working directories to durable projects and initializes installation and conversation identities.
resource: packages/cli/src/integrations/sessions/store.ts
tags: [cli, ids, storage, memory]
status: stable
---

# Project and session state

The working directory is where tools execute. The Project groups durable
conversations and searchable memory. A Session identifies one conversation; a
Run identifies one execution within it. Changing the working directory does
not require a new Project when both directories belong to the same checkout.

## Selecting a Project

The CLI canonicalizes the working directory, resolving symlinks, then:

1. Finds the nearest directory containing `.git`. A `.git` file is also a
   boundary, so Git worktrees remain separate.
2. Reuses or creates the root-path binding for that checkout and installation tenant.
3. Outside a repository, binds the working directory itself.

Opening a new checkout from its root or `packages/cli` now selects the same
Project and Topic. A new Project's display name is its root directory's name.
Its generated ID remains a logical ownership key. SQLite indexes the canonical
root and tenant; there is no directory or JSON registry per Project. `namzu state` uses the same central selector as session startup.
Its filesystem inventory still covers the working directory's `.namzu` and
the application home; run it at the checkout root to count root-level authored
memory as well.

The resume picker uses project-scoped session enumeration when the store supports
it, then checks Topic membership. The SQLite store does not scan unrelated
Projects to list the current checkout. Message logs are still read to derive
missing titles, previews and counts; a bounded metadata index remains a separate
optimization. `namzu history --session <id> --cwd <directory>` accepts a
conversation UUID or a host session key. Omitting `--session` selects the most
recent conversation for that workspace, as the command help describes.

Tool execution, project trust and configuration continue to use the selected
working directory. Nested repositories and worktrees have distinct roots.
Unrelated scratch directories are separate Projects: their common `/tmp`
parent does not establish shared ownership.

## Identity and persistence

Generated state lives under `~/.namzu`, or `NAMZU_HOME` when configured:

- `identity.json` holds the installation's tenant identity.
- `plugin-settings/` holds explicitly saved per-plugin startup choices; see
  [Plugins](plugins.md). The state inventory classifies these private records
  as configuration.
- `state/sessions.sqlite` holds Projects, root bindings, Sessions, message records,
  delegation links and summaries. Writes use SQLite transactions; ownership
  checks and updates commit together, including across processes.
- `state/learning.sqlite` holds explicitly invoked resident learning cycles, their
  ordered events, ownership and receipt totals. `learning/artifacts/` holds
  immutable JSON content referenced by SHA-256. See
  [Durable learning records](../sdk/resident-learning-storage.md).
- `sessions/<sessionId>/` holds conversation evidence and `runs/<runId>/`
  transcripts and artifacts. There is no parent Project directory.
- `cli/` holds titles and desktop mappings. Desktop keys include their Project
  identity, so two workspaces can use the same external window key independently.
- `memory/<projectId>/` isolates stored memories by workspace: one Markdown file
  per memory and a generated `MEMORY.md` index (see [Memory](memory.md)). This
  partition is created when the agent opens its memory tools, not when listing
  sessions.
- `residents/<projectId>/<agent>/` holds explicitly created resident state.
- `checkpoints/<sessionId>/`, `delegation-history/<sessionId>/`, `goals/` and
  `tenants/` retain their own session, run or tenant ownership boundaries.

The installation identity is published once. The CLI Topic is deterministically
bound to the Project UUID without a separate topic file. Concurrent launches
select one Project through a unique tenant/root constraint. Read-only inspection
never creates a database or changes its schema. The database uses a rollback
journal and short transactions; readers do not create WAL sidecars.

The CLI requires Node.js 22.13 or newer for native SQLite. SDK consumers can
continue using the existing disk or in-memory drivers on Node.js 20.

### Runtime state growth

Every run the CLI starts keeps its newest 10 checkpoints
(`runConfig.pruneKeepLast`, `packages/cli/src/integrations/state/retention.ts`).
That includes interactive turns, headless runs, resumed and drained runs, and
delegated children. The kernel's own default keeps all of them. Nothing in the
CLI reads an older checkpoint: every resume reads the checkpoint it was handed
or the newest one. A checkpoint whose approval is still outstanding is never
pruned, however old. Each checkpoint references the run's single stored
history instead of copying it; see [Durable run storage](../sdk/run-storage.md).

Retention bounds the count; the run's history log bounds the bytes. Each
checkpoint, and the settled `messages.json`, references the run's messages in
`runs/<runId>/history/` instead of copying them, and the lines no record
references any more are collected once they outweigh the live ones. See
[Durable run storage](../sdk/run-storage.md).

When a turn completes, the CLI removes the crash dumps in that session's
`runs/emergency/` that are older than the turn. An interrupted turn or
`namzu run` writes one, and the CLI never resumes from it: the next turn
continues the conversation under a new run id, so the kernel's own cleanup,
which clears a dump when the same run id completes, never reached it.

Measured with `scripts/benchmarks/cli-state-growth.mjs`. It runs the built
`namzu run` against a local scripted endpoint, and every model turn but the
last asks for `read` on a different 4 KB file. "Before" is `main` at
`cf271eb9`, measured on the same machine in the same session:

| Invocations × tool calls | Files before | Bytes before | Files after | Bytes after |
|---|---|---|---|---|
| 3 × 50 | 173 | 29,621,057 | 53 | 4,101,738 |
| 1 × 200 | 209 | 81,982,930 | 20 | 6,283,563 |

Before, checkpoints were 25,675,207 and 76,337,386 of those bytes and
`messages.json` 933,290 and 458,755. After, checkpoint records are 193,590
and 195,481 bytes, the history logs 895,274 and 889,932, and `messages.json`
1,092 and 11,619. A run's largest file is its event log, `transcript.jsonl`.
Wall time went from 4.4 s to 4.9 s and from 23.6 s to 24.5 s. Most of it is
retention, which reads the run's checkpoint files after every iteration: in
`scripts/benchmarks/runtime-state-growth.mjs`, 50 iterations take 519 ms
without it and 684 ms with `pruneKeepLast: 10`.

Three invocations in one directory leave one Project, and nothing is written
under the working directory.

### Previous storage format

This is a new CLI storage format. Existing `projects/` trees are retained as
historical data, not read, migrated or deleted automatically. Old conversations,
resident state and generated memory are accessible with the matching older CLI
and its original application home; they do not appear in the new database.
Keep that home backed up before changing versions. Provider credentials,
preferences, authored instructions and plugin settings retain their locations.
New launches do not create or write a `projects/` directory.

Entity IDs are opaque UUIDs. Prefixed IDs are rejected at admission. Callers use the SDK's constructors; tenant and Project
membership are checked separately by the stores. The root-path binding selects
the Project, independently of its ID's spelling.

An installation whose `identity.json` still contains a prefixed tenant ID
cannot start the UUID-only CLI. To start fresh, close Namzu, move that identity
file to a backup location, then launch again. Only an absent identity is minted
automatically. Keep the backup: a new tenant selects new Projects, and existing
conversations remain on disk under their original identity without being
imported or made resumable. Provider preferences and credentials do not need
to be reset. For an accidentally damaged UUID identity, restore its valid
backup to retain access to the same Projects.

## State boundaries

A historical binding for an exact subdirectory cannot override the checkout
root. Root and subdirectory launches select one Project and Topic. Old records
are left on disk; they are not merged, imported or renamed. A global `cli.json`
or project-local runtime store is not a Project selector. `namzu state`
inventories historical files without treating them as active authority.

Curated memory follows the checkout root for new files, with existing
directory-local memory taking precedence. See [Memory](memory.md).

## Delegated work

A delegated run belongs to the invoking run's actual tenant, Project, Topic
and parent Session. Each parent run gets its own scheduler context, so parallel
runs and a conversation change cannot overwrite one another's lineage. The
scheduler uses the real parent run ID for events and stored child-run metadata.
Concurrent parent runs in the same Session share the manager that enforces
live delegation width. Finished history does not consume slots. Excess tasks
remain queued with their own IDs; they reserve budget and start execution only
when admitted, after rechecking the parent and Project/Topic state. A run can
only inspect or control tasks it owns.
Settling or closing a parent releases its scheduler and cancels children it
still owns.

Child run artifacts live under
`sessions/<childSessionId>/runs/<parentRunId>/children/<childRunId>`.
Child
Session and Topic bookkeeping is an in-memory view of the actual parent
identity, rather than another resumable CLI conversation. Existing child
artifacts are left in place; this change does not migrate or resume historical
subagent trees.

Central Project metadata must exist before delegation, and archived Projects
or parent Sessions refuse new delegation. A first conversation may not yet
have a Session record; it uses the Session ID already chosen by the caller.
Embedded sessions without an application state root use their supplied scope
without creating durable Project records. Their generated state still goes to
the application home, never to `<cwd>/.namzu`. A session created with no scope
derives its Project from the working directory's checkout, so two sessions in
one directory share generated memory.

Task storage is also bound to the actual run. Calls that omit an explicit run
filter use the current run instead of a shared placeholder directory.

A durable `drain` resolves its Topic from the persisted Session and verifies
the supplied Project and tenant before creating a provider session. A fabricated
Topic or checkpoint-only scope without its Session record is refused.

`drain` passes configured `limits.tokenBudget` and `limits.maxIterations` to its
resume host. Use the same token limit that owns the original run's budget ledger;
resuming does not grant a fresh allowance. A mismatch is refused. Checkpoint
recovery preserves [unknown tool outcomes](../sdk/tool-execution.md#recovery-after-an-interrupted-effect)
instead of automatically repeating actions without a recorded completion.

Durable recovery also carries configured compaction, memory and web options,
and mounts conversation evidence against that persisted Session. An explicitly
disabled web or memory option is preserved. A resumed run that settles as
`failed` or `cancelled` is included in `drain`'s `failed` results and produces
exit code 1; entering the resumed loop alone does not count as success.
