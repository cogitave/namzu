---
type: Reference
title: Memory
description: Curated file scopes, bounded reads and save diagnostics, and project-scoped structured memory recalled before each model step.
resource: packages/cli/src/memory/store.ts
tags: [cli, memory, prompt]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-04T00:00:00Z }
---

# Memory

There are two kinds, and they do different jobs.

## Curated memory: read into every turn

Three files, two scopes. Each is markdown the operator may edit by hand.

| File | Scope | What belongs there |
| --- | --- | --- |
| `<project>/.namzu/MEMORY.md` | project | facts about this repository: how tests run, what a name means here, a decision taken |
| `~/.namzu/MEMORY.md` | user | facts that hold in every project |
| `~/.namzu/USER.md` | user | who the operator is |

The user paths above use the default application home. An explicit `NAMZU_HOME`
moves both user files into that application directory. Project files stay bound
to the checkout.

`/memory`, `/memory show` and `/memory list` display the combined curated memory
without saving anything. `show` and `list` are aliases for this content view;
`list` does not enumerate memory-file paths.

The terminal report labels each saved section and shows its full file path.
Each preview is limited to 20 lines and 2,000 characters; an omission notice
identifies the remaining content and the file to open. Model-directed prompt
instructions are not printed in this report. The per-turn model prompt retains
its separate 8,000-character section budget described below.

`#note` and `/memory add <text>` append to the **project** file.
`/memory --user add <text>` appends to the user file. Bare `add` shows usage
without writing. The inspection keywords and `add` are case-insensitive; saved
text keeps its original case. The existing `/memory <text>` and
`/memory --user <text>` shortcuts remain available for ordinary facts.
To save a literal `show`, `list` or `add`, use `/memory add show`, for example.
Multiword facts such as `/memory show errors clearly` remain notes.

For new files, `<project>` is the nearest checkout root (a `.git` directory or worktree `.git` file), or the working directory when outside a repository. Launching from `packages/cli` therefore reads and writes the checkout's memory. An existing `.namzu/MEMORY.md` in the working directory takes precedence, including an empty file, so old directory-specific notes remain accessible. Create that file explicitly to keep directory-specific memory. This changes the default destination for a new note from a repository subdirectory; it does not move existing files.

Curated files are read at the start of each send or resume. Editing or deleting a
file affects that next snapshot, including after a new session or restart. A run
already in progress keeps its curated snapshot through its model steps. Edit the
file to correct or remove a note; the slash command appends and inspects, and does
not offer an update or delete operation.

Each section keeps at most the first 8,000 characters in the model prompt, with a
notice naming the omitted amount. A trailing partial line may be omitted too;
Unicode supplementary characters are not split. When an append succeeds but the
new note will not fit completely in this section budget, the terminal says it
was saved to the named file and asks you to curate that file. It does not claim
the whole note was remembered into the prompt. The inspection preview has its
separate 20-line/2,000-character cap.

### File admission and diagnostics

Project files must resolve within the current checkout root (or working
directory outside a checkout). User files must resolve within the application
home, which must itself be a real directory. Symlinks within those roots are
allowed, including project `.namzu` directories; leaf or ancestor symlinks that
escape the scope are refused. A broken local link is reported rather than
silently falling back to checkout memory.

Each file must be a regular UTF-8 text file without NUL bytes and no larger than
1 MiB (1,048,576 bytes). Namzu checks its size before reading, uses bounded chunk
reads to catch files that grow during the read, and checks the opened file's
identity. Missing and whitespace-only files are ordinary empty memory. Unsafe,
malformed, oversized or unreadable files are omitted with a path-specific notice
in the terminal memory report and on send; resume records the diagnostic in the
CLI log. Their contents are not injected. Appending refuses these files without
replacing them, and refuses an append that would exceed the byte limit.

To migrate an existing file that is refused, move its intended content inside
its scope, repair the link or permissions, convert it to valid UTF-8, or curate
it below the file limit. The prompt section cap remains 8,000 characters even
when a file is under 1 MiB.

## Structured project memory: tools and automatic recall

The kernel store is separate from the curated markdown files. The CLI binds it
to the project's generated state directory. `save_memory` creates a record,
`search_memory` finds records, and `read_memory` reads a complete record.
`update_memory` corrects a record or archives an obsolete claim;
`delete_memory` removes it. These tools do not edit the files shown by `/memory`.
A fresh session in the same project can retrieve persisted records.

Automatic recall is enabled by default. Before each model step, the CLI searches
active project records using terms from the latest operator message, and adds
at most three matching records within a total 6,000-character budget or the
smaller available estimated context headroom, including source labels and
framing. Body text can match even when the title and summary
do not. Generic messages such as “continue” do not enumerate arbitrary records.
This read-only step makes no additional model call and has a one-second
deadline; an error leaves that step without recalled context and reports the
failure through the runtime's preparation diagnostic.

Recalled text is marked as historical claims and reference data. Current user
directions and fresh evidence take precedence; recall does not create a verified
fact or an authoritative pin. Edits, archiving and deletion are reflected at the
next recall step, and the recalled block is not saved as a new user message.
Set `memory.recall: false` in CLI configuration to disable automatic recall while
keeping the explicit memory tools available.

The default promoter writes useful extracted claims to this store when a run
settles. `compaction.consolidate: true` selects consolidation instead, so the CLI
does not run both writers. Writing remains separate from curated file appends
and from read-only recall; disabling recall does not disable writes. See
[structured memory](../sdk/memory.md) for search, promotion and recovery limits.

## Bounded live check

On 2026-09-07, four fresh CLI processes used `gpt-5.6-luna` at `low` effort
against an isolated project store. A fact present only in a record's body was
recalled as `14 hours`; after a host correction the next process answered
`28 hours`. After archiving the record, and separately with recall disabled
while it was active, the answer was `UNKNOWN`. All four cases made one model
request and no tool calls, reporting 20,493 tokens in total. The outgoing
requests included the matching memory only in the first two cases.

This checks retrieval, freshness and opt-out on a small controlled example.
It does not establish general reasoning quality, semantic retrieval or automatic
truth verification. Offline regressions additionally cover project isolation,
concurrent writers, context limits, cancellation and steering across compaction.
