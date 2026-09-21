---
type: Reference
title: Memory
description: Operator-curated files read into every turn, and typed stored memory — one Markdown file per memory with a generated index in the prompt — that notes, the memory tools and recall share.
resource: packages/cli/src/memory/store.ts
tags: [cli, memory, prompt]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-04T00:00:00Z }
---

# Memory

There are two kinds, and they do different jobs. **Curated memory** is text the
operator writes, read verbatim into every turn. **Stored memory** is typed
records, one Markdown file each, that `#note`, `/memory add`, the model's memory
tools and the end-of-run writers all share; every turn carries its index, and
recall adds matching records. In the prompt the two never share a heading:
curated sections are `## About the user`, `## Curated memory (all projects)` and
`## Curated memory (this project)`; stored memory is `## Stored memories (index)`.

## Curated memory: read into every turn

Three files, two scopes. Each is markdown the operator writes and edits by hand.

| File | Scope | What belongs there |
| --- | --- | --- |
| `<project>/.namzu/MEMORY.md` | project | what the operator wants every turn in this repository to read |
| `~/.namzu/MEMORY.md` | user | facts that hold in every project; `/memory --user add` appends here |
| `~/.namzu/USER.md` | user | who the operator is |

The user paths above use the default application home. An explicit `NAMZU_HOME`
moves both user files into that application directory. Project files stay bound
to the checkout.

`/memory`, `/memory show` and `/memory list` display stored memory's index lines
(with the directory the files are in) followed by the combined curated memory,
without saving anything. `show` and `list` are aliases for this content view.

The terminal report labels each saved section and shows its full file path.
Each preview is limited to 20 lines and 2,000 characters; an omission notice
identifies the remaining content and the file to open. Model-directed prompt
instructions are not printed in this report. The per-turn model prompt retains
its separate 8,000-character section budget described below.

`#note` and `/memory add <text>` save a typed memory in stored memory (below),
not in this file. `/memory --user add <text>` still appends a bullet to the user
file, because stored memory belongs to one project. Bare `add` shows usage
without writing. The inspection keywords and `add` are case-insensitive; saved
text keeps its original case. The existing `/memory <text>` and
`/memory --user <text>` shortcuts remain available for ordinary facts.
To save a literal `show`, `list` or `add`, use `/memory add show`, for example.
Multiword facts such as `/memory show errors clearly` remain notes.

For new files, `<project>` is the nearest checkout root (a `.git` directory or worktree `.git` file), or the working directory when outside a repository. Launching from `packages/cli` therefore reads and writes the checkout's memory. An existing `.namzu/MEMORY.md` in the working directory takes precedence, including an empty file, so old directory-specific notes remain accessible. Create that file explicitly to keep directory-specific memory. This changes the default destination for a new note from a repository subdirectory; it does not move existing files.

Curated files are read at the start of each send or resume. Editing or deleting a
file affects that next snapshot, including after a new session or restart. A run
already in progress keeps its curated snapshot through its model steps. Edit the
file to correct or remove a line; the slash command inspects, and appends only
with `--user`.

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

## Stored memory: typed files, an index in every turn, and recall

The CLI keeps stored memory in the project's generated state directory —
`<NAMZU_HOME>/memory/<project-id>/` for a session with an application home
(the default), `<cwd>/.namzu/memory/` for an embedded session without one — as a
[`MarkdownMemoryStore`](../sdk/memory.md#markdown-memory-files): one
`<name>.md` per memory with frontmatter `name`, `description`, `type`,
`status`, `createdAt`, `updatedAt` and optional `tags`, then the body, and a
generated `MEMORY.md` index beside them. The files are plain Markdown; edit one
by hand and the next turn sees it.

| Type | What it holds |
| --- | --- |
| `user` | who the operator is and how they like to work |
| `feedback` | a rule the operator gave, then `Why:` and `How to apply:` lines |
| `project` | a fact or decision the code and its history do not already say (the default) |
| `reference` | where to look for something |

`#note <text>` and `/memory add <text>` save a `project` memory named after the
note (`/memory add --type feedback <text>` picks another type; `--type` is
refused with `--user`). The terminal names the file written. A note whose exact
text an active memory already holds is not saved again; the terminal names the
memory that holds it. A session with no provider has no store, and its notes are
appended to the curated project file as before.

Every send and resume puts the index in the system prompt under
`## Stored memories (index)`: one line per active memory you or the model
saved, `- [name](name.md) — description`, each at most 150 characters (a note's
name is its first words, at most 32 characters, so the description keeps most
of the line), at most 200 lines with a final line saying how many more exist and
to search for them. What the runtime writes after a run by itself — the run
promoter's record, or consolidation's with `compaction.consolidate` — is kept in
the same directory and found by recall and `search_memory`, but never listed:
it is written after almost every run, and a system prompt that changed with it
would lose its prompt cache nearly every turn. Your `feedback` and `user`
memories (notes, `/memory add --type`, hand-written files) come first, then the
model's, then the rest, by name within each; the order changes only when a
listed memory does, and the 200-line cap drops `project` and `reference` lines
before any of yours. The section tells the model to read a memory before relying on it, to
update rather than duplicate, that memories are point-in-time, and that what
earlier runs recorded on their own is found with `search_memory`. The index is
rendered from the files at that moment. A memory file the store cannot read
leaves that turn without the index and shows a notice naming the file; the turn
still runs.

The model's tools work on the same files. `save_memory` creates a memory (a name
another memory holds is refused and pointed at `update_memory`),
`search_memory` finds memories, `read_memory` reads one by ID or name, with its
age and its `[[name]]` links resolved, `update_memory` corrects or archives
one by ID or by the name the index shows, and `delete_memory` removes it. A
memory whose file would exceed 256 KiB, or that contains a NUL character, is
refused before it is written, so one oversized save cannot stop the store. A fresh session in the same project reads
the same files.

### Moving the older memory in

A JSON store in the stored-memory directory (`index.json` and `content/`, from
earlier releases) is moved at the first launch after upgrading: imported record
by record with its ids, timestamps and status, then renamed to
`index.json.migrated` and `content.migrated`. A record too large for a memory
file (over 256 KiB) or containing a NUL character is not imported; the launch
names it and the retired `content.migrated/<id>.json` that still holds it. Any
other failure leaves the JSON store in place — the store refuses to answer
rather than answer without those records — and is shown at launch and retried
at the next. Nothing is imported twice.

The project's curated `MEMORY.md` is not rewritten at launch. Nothing can tell a
bullet `#note` appended from one you wrote, so when the file holds single-line
top-level bullets the launch says how many and offers `/memory import-notes`,
once per curated file (the checkout's file and a subdirectory's own
`.namzu/MEMORY.md` are offered separately). Until you run it they stay curated
and reach every turn as before. `/memory import-notes` moves them into
`project` memories, keeps the file's text before the move beside it as
`MEMORY.md.before-typed-memory` (a later run whose text differs writes
`MEMORY.md.before-typed-memory-2`, and so on; no copy is overwritten), and
rewrites it without them only if nothing changed it meanwhile.

What stays, exactly:

- a bullet in a list that starts on the line directly under a Markdown heading
  (`## Conventions` then `- use tabs`). A blank line ends that list, so
  `# Project memory`, a blank line, then `- note` — what `#note` left in a file
  with a heading — is offered, and so is a bullet after a blank line that
  follows a heading's list. A note appended straight onto a heading's list,
  with no blank line between, cannot be told from the list and stays;
- a bullet followed by a line that is neither blank nor a bullet: a note that
  spanned several lines, or a bullet with a nested list;
- prose, headings and nested bullets.

A bullet directly under a line of prose is offered, since `#note` produced
that too when the file ended in prose. The report counts the top-level bullets
that stayed. Running it again moves nothing twice.
A `migration.json` in the stored-memory directory records, per curated file,
that it was offered, when it was moved, and how many memories its bullets
became. `~/.namzu/MEMORY.md` and `USER.md`
are never touched.

Automatic recall is enabled by default. Before each model step, the CLI searches
active stored memories using terms from the latest operator message, and adds
at most three matching records within a total 6,000-character budget or the
smaller available estimated context headroom, including source labels and
framing. Body text can match even when the title and summary
do not. Generic messages such as “continue” do not enumerate arbitrary records.
This read-only step makes no additional model call and has a one-second
deadline; an error leaves that step without recalled context and reports the
failure through the runtime's preparation diagnostic.

Recalled text is marked as historical claims and reference data. A memory last
updated more than a day ago is recalled with its age and a reminder to verify the
files and functions it names before relying on it. Current user
directions and fresh evidence take precedence; recall does not create a verified
fact or an authoritative pin. Edits, archiving and deletion are reflected at the
next recall step, and the recalled block is not saved as a new user message.
Set `memory.recall: false` in CLI configuration to disable automatic recall while
keeping the explicit memory tools available.

`memory.identifierGrounding` (default false) controls the automatic recall policy for technical
word tokens containing letters and digits. With it enabled, a question naming
`quartz9` cannot automatically inject an `opal7` record solely because both
mention seconds. Set it to `false` for the earlier broad lexical policy. The
same setting applies to new sends and checkpoint resumes; explicit search tools
remain available in either mode. See [structured memory](../sdk/memory.md) for
exact matching rules and alias limitations.

The default promoter writes useful extracted claims to this store when a run
settles. `compaction.consolidate: true` selects consolidation instead, so the CLI
does not run both writers. Writing remains separate from curated file appends
and from read-only recall; disabling recall does not disable writes. A run whose
learnings match an earlier consolidation's writes nothing. See
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
