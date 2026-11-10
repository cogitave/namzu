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
tools and the end-of-turn writers all share; every turn carries its index, and
recall adds matching records. In the prompt the two never share a heading:
curated sections are `## About the user`, `## Curated memory (all projects)` and
`## Curated memory (this project)`; stored memory is `## Stored memories (index)`.

The curated sections and the stored index reach the model as one hidden reminder,
not as text added to every request: the whole memory the first time a
conversation needs it, then only the part that changed (a part you removed is
reported as no longer present). Every request therefore begins with the earlier
ones, so the provider can cache the memory instead of billing it again at each
step, and a note saved mid-session does not rewrite the cached system prompt. A
compaction that drops the reminder makes the next request say the memory again,
in full.

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

`/memory show` and `/memory list` display stored memory followed by
the combined curated memory, without saving anything. Stored memory comes in two
labelled sections, each with its count and the directory the files are in:
`Stored memories (N), in every turn's index` — every active memory you or the
model saved, the lines the prompt's index carries, uncapped — and
`Recorded by turns (N), not in the index; search_memory finds them` — the active
records the session memory promoter or consolidation wrote on their own, newest
first. A store holding only such records shows the second section alone. `show` and
`list` are aliases for this content view.

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

Started in the home directory with no `NAMZU_HOME`, the project's
`.namzu/MEMORY.md` and the user's `~/.namzu/MEMORY.md` are one file. It is read
once, as the user memory, and is not injected a second time under the project
heading.

Curated files are read at the start of each send or resume. Their content is
placed in a request-only user-role `step-context` message, after conversation
history; it is not system guidance or saved as an operator message. Editing or
deleting a file affects the next snapshot, including after a new session or
restart. A turn already in progress keeps its snapshot through its model steps.
Edit the file to correct or remove a line; the slash command inspects, and
appends only with `--user`.

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

The CLI keeps stored memory in the project's directory under the application
home, `<NAMZU_HOME>/projects/<slug>/memory/` — never under the working
directory — as a
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

### Keeping memory during a session

A session that mounts the memory tools carries a `## Memory` section in its
static system prompt, in the stable prefix before the environment block, so it
never changes the cached prefix. It tells the model to save what it expects to
matter again: the person's preferences and corrections, decisions and the
reason for them, a lesson from a failure (what went wrong, the cause, what to
do instead) and pointers to resources outside the repository. A lesson is kept
only when it is likely to come up again or was not obvious; a one-off slip such
as a typo, a wrong flag or a missing install is not. It leaves out what the
repository or its docs already record and what only matters to the current
conversation: progress and the current plan belong in the task list when the
session has one, and in the conversation when it does not. It also asks for one
fact per memory with a short one-line description, an update of a matching
memory instead of a duplicate, the removal of a memory found wrong, and a check
of a recalled memory against the current code before acting on it. When the
person says "remember", the model saves it; when the repository already records
the thing, it saves only what was surprising or non-obvious about it. When the
person says "forget", it finds the memory and removes it. A session that
withholds `save_memory` gets no such section. A
sub-agent that holds `save_memory` gets the same section in its own prompt (with
progress belonging in the conversation, since a sub-agent has no task list).
The mechanics (types, the `Why:` and `How to apply:` lines, `[[name]]` links,
revisions) stay in the descriptions of the memory tools.

#### Saving does not ask

In the default mode (ask before changes) and in the mode that approves edits,
`save_memory` and `update_memory` run without an approval prompt. They write only
to namzu's own memory store under its home, never to a workspace file, and the
write is recorded in the turn like any other tool call, with the memory marked
as written by the model. `delete_memory` still asks, since it removes a memory.
Plan mode, strict mode and the classifier mode treat the memory tools as any
other write, and a `permissions` rule that asks about or denies one still
decides. Before this change every save asked "Do you want to run save_memory?".
There is no setting that brings the prompt back for the memory tools alone; to
be asked, write `permissions: { save_memory: "ask" }` (and the same for
`update_memory`).

Every send and resume takes a snapshot of the index and offers it, subject to
the current request budget, in a request-only user-role `step-context` message under
`## Stored memories (index)`: one line per active memory you or the model
saved, `- [name](name.md) — description`, each at most 150 characters (a note's
name is its first words, at most 32 characters, so the description keeps most
of the line), at most 200 lines with a final line saying how many more exist and
to search for them. What the runtime writes after a turn by itself — the session
memory promoter's record (`metadata.source: 'session-memory'`), or
consolidation's with `compaction.consolidate` — is kept in the same directory
and found by recall and `search_memory`, but never listed: it is written after
almost every turn, and listing it would make the index noisy and cost more
request tokens. Your `feedback` and `user`
memories (notes, `/memory add --type`, hand-written files) come first, then the
model's, then the rest, by name within each; the order changes only when a
listed memory does, and the 200-line cap drops `project` and `reference` lines
before any of yours. The section points the model to `read_memory` for a listed memory and says that
what earlier turns recorded on their own is found with `search_memory`. The index is
rendered from the files at that moment. A memory file the store cannot read
leaves that turn without the index and shows a notice naming the file; the turn
still runs.

A stored-memory operation lock held by a live Namzu process is reported with
its path even without `--debug`: close that process or wait for it to finish. A
lock left by a process that died (including a crash on a full disk) is removed
automatically at the next start. This lock is separate from the conversation's
writer lease. See [disk coordination and recovery](../sdk/memory.md#disk-coordination-and-recovery).

The snapshot stays fixed across model steps in that send or resume; the next
send or resume reads the files again. File-backed curated memory, the stored
index and automatic recall all enter request-only user-role context. Any of
these files can be changed by an agent tool when filesystem access allows it,
and stored records can contain model-authored text. Request-only context is
not saved in conversation history or included in later compaction as an
operator message. This role limits the authority assigned to memory; it cannot
guarantee that the model will ignore a malicious instruction inside it. To
provide trusted system guidance, pass explicit system instructions through
the host, such as `SendOptions.extraSystem`, rather than placing them in a
memory file. Hosts that depended on `USER.md` or `MEMORY.md` appearing in the
system prompt must migrate those instructions. Moving changing memory after
history preserves a cacheable system prefix where the provider supports it,
but memory context still consumes input tokens on each request and a cache
hit is not guaranteed.

After compaction, optional recall and any model selection, the CLI admits
file and index memory against the estimated room left in the selected model's
request. A crowded window may shorten either section with an omission notice,
or omit it when there is too little room to show a useful fragment. The
automatic recall stage uses its own budget first; memory files and the index
use the room that remains. The full files remain available through memory and
file tools.

The model's tools work on the same files. `save_memory` creates a memory (a name
another memory holds is refused and pointed at `update_memory`),
`search_memory` finds memories, `read_memory` reads one by ID or name, with its
age and its `[[name]]` links resolved, `update_memory` corrects or archives
one by ID or by the name the index shows, and `delete_memory` removes it.
For a word search, `search_memory` examines up to 256 recent candidates at a
time. An incomplete page says so and gives a `scan_offset` for the next page;
an empty incomplete page does not claim that no older memory matches.

A `read_memory` result also supplies an opaque revision. The model can pass it to
`update_memory` or `delete_memory` to refuse a stale correction or deletion
after another writer or a hand edit changed the record. Without a revision,
those tools retain their ordinary last-writer-wins behavior. A JSON body's
tool output stays exactly the stored JSON; the revision is delivered alongside
it in a separate model-visible text block.

A memory whose file would exceed 256 KiB, or that contains a NUL character, is
refused before it is written, so one oversized save cannot stop the store. A
fresh session in the same project reads the same files.

### Seeing and deleting stored memory

`/memory` with no arguments opens a picker titled Memory that lists every
active stored memory of the project: the ones you or Namzu saved first, then
those turns recorded on their own, newest first within each group. A row shows
the title, then who wrote it (`you`, `Namzu saved`, `recorded by a turn`), the
type and the age. The first row is `Delete all N memories`, which removes
every stored memory of the project, also those you or Namzu saved. When turns
recorded some but not all of them, the next row is `Delete all N memories
recorded by turns` (`Delete the 1 memory recorded by a turn` when there is
one). With no stored memory it prints the report instead.

Selecting a memory offers Show, which prints the whole memory with its file, and
Delete, which asks once more (Delete or Keep) before removing the file. The
delete refuses a memory that changed since the list opened and says so; the
next `/memory` lists it again. `Delete all N memories` asks `Delete all N
memories?`, with Keep selected, and the recorded row asks `Delete all N
memories recorded by turns? Memories you or Namzu saved stay.`; each then
reports how many it deleted, and says so when the conversation already carries
one of them (`/clear` starts fresh without it). A reply in progress is not
interrupted: the next recall step simply no longer finds the file.

`/memory delete <name-or-id>` opens the same confirmation for the memory with
that exact name or id (`No memory named “x”. /memory lists them.` when none,
a list when several), `/memory delete --recorded` opens the confirmation for
those turns recorded, and `/memory delete --all` the one for every memory.
The curated files (`MEMORY.md`, `USER.md`) are not memories in this sense
and are never listed or deleted here; `/memory show` still prints them with
their paths. A note that begins with the word `delete` is saved with
`/memory add delete ...`.

### What turns record on their own

A turn no longer records what you asked for. The CLI screens every claim before
the turn's record is written:

- Your messages are kept only when they state something lasting: a preference or
  rule (`always`, `never`, `prefer`, `don't`, `must`, `from now on`; `her zaman`,
  `asla`, `tercih`, `kullanma`, `bundan sonra`), at most 240 characters, not a
  question and not a request to do something now. Everything else is dropped.
- The record's title is `Session notes` with the names of the files the turn
  touched, never the text of your first message. A turn with nothing lasting to
  record writes no record.
- Search traces (`Searched: ...`) and raw tool error text are not recorded.
- A claim that looks like a secret (an API key or token, a private key, a JWT, a
  URL with a password, a long random string) or like an injected instruction
  (role markers, "ignore previous instructions", tool-call or system tags) is
  dropped.

The log carries only how many claims were dropped and why, never their text.

The first session started after this change goes through the records Namzu
derived itself earlier (`recorded by a turn`) once, in the background. A record
the screen would not write today is archived, not deleted: it stops being
recalled and stops appearing in `/memory`. Memories you or Namzu saved are never
touched. A marker file named `.derived-screen-v1` in the memory directory records
that the pass is done; a failed pass leaves it out and the next session tries
again. To restore an archived record, open its file in the memory directory and
change `status: archived` to `status: active`; to run the pass again, delete the
marker.

### How what turns learn is curated

The screened claims of a turn no longer become a record of their own. When the
turn ends, the CLI appends them to a small durable inbox, one JSON line in
`<NAMZU_HOME>/memory-inbox/<project>.jsonl`, and goes on. That takes a few
milliseconds and calls no model. Nothing is written to your memory in the turn,
and a crash after the append loses nothing: the next process finds the line.

Off the turn, the small model curates the inbox. It runs:

- a quarter of a minute after a turn ends, when no other turn has started;
- when the next turn starts, after that turn has been dispatched, so it never
  delays the reply (this is also how a new process picks up what an earlier one
  left, including a one-shot `exec` run that ended before its own drain);
- when the session closes, for at most eight seconds.

At most eight claim sets go to the model in one call. For each, Namzu first
finds the five to eight active memories that share the most words with it, of
every writer: yours, the ones the assistant saved with `save_memory` and the ones
turns recorded. The model sees each claim set, and for each related memory only
its id, title, description, type, who wrote it and age, never its body. It answers
with one operation per claim set:

| Operation | Meaning | What Namzu does |
| --- | --- | --- |
| `add` | A lasting fact no related memory holds. | Writes a record, marked `curated` and `unverified`, with the reason in its metadata. |
| `update` | It refines a related memory a turn recorded. | Rewrites that record in place. |
| `supersede` | It contradicts or replaces such a memory. | Writes the new record linking to the old one (`supersedes`), then archives the old one with `supersededBy` and `invalidAt`. |
| `noop` | A related memory already holds it, or it is not worth keeping. | Nothing. |
| `reject` | It is unsafe or is not a fact. | Nothing. |

The model proposes and Namzu decides. A target must be one of that claim set's
related memories. A memory you wrote, or the assistant saved, is never changed:
when it already says the same thing the claim is dropped, so a preference the
assistant just saved is not written a second time by the turn's record. A claim
the model marks `ephemeral` is dropped. Every field has a length limit, and the
secret and injected-instruction screen runs again over everything the model
wrote. An update that finds the record changed since it was read (you edited it,
or deleted it) is dropped; the record you changed wins. Nothing is ever deleted
by this: a replaced record is archived, and `/memory` does not list it. To bring
one back, change `status: archived` to `status: active` in its file.

When the small model cannot be used (none is set aside, the route would be the
conversation's own model, it does not answer within 25 seconds, or it answers
something unreadable), the claim sets are written as they were before, one
record each, so a failing small model never makes memory worse than it was. A
claim set the model said nothing about is written that way too. The claims were
already screened (see above) before they reached the inbox.

When a drain changed something, one quiet row appears in the transcript, a line
per change: `Remembered: <title>`, `Updated: <title>`, `Replaced: <old> → <new>`.
Nothing appears for a claim that was skipped. `/memory show <name>` of a record
that replaced another says `Replaced: <old title>`.

The curation log, `<NAMZU_HOME>/memory/curation.jsonl`, has one line per
operation: the time, the operation, the ids it touched, the turn, a reason code
(`added`, `updated`, `superseded`, `noop` (held already, or not worth keeping), `ephemeral`, `secret`,
`injection`, `invalid-target`, `protected-target`, `conflict`, `duplicate-digest`,
or for a fallback `no side model`, `main route`, `timeout`, `invalid`, `error`,
`unanswered`), whether the small model or the fallback ran, how long it took
and the outcome. It holds no claim, title or conversation text, and a run of
`fallback` lines is how a small model that is silently failing shows.

Privacy: the small model sees the claims a turn learned (already screened) and
the titles and descriptions of related memories, sent to your own provider.
Set `memory.curation: off` in your own config to keep the earlier behaviour:

```yaml
# ~/.namzu/config.yaml
memory:
  curation: off   # default: on
```

With it off there is no inbox and no model: the screened claims are written when
the turn ends, as before. A project's `namzu.config.json` (or the local file),
including a profile in it, cannot set `memory.curation`; only your own config and
a managed config can. With `compaction.consolidate` on, consolidation writes the
turn's record and the inbox is not used. If the decision point `memory` is on,
it still looks at a turn's claims first, when the turn ends: a confident no keeps
them out of the inbox, and that single question to your decision endpoint is
asked as the turn is released.

### Seeing which memories a message used

When stored memory went into a turn, a quiet row appears under the message:
`● Used 2 memories (ctrl+o to expand)`. Ctrl+O opens it into one line per
memory, `<title> · <who wrote it> · <age> · <why>`, and a last line,
`/memory delete <name> removes one.`, naming the first memory. Later recalls in
the same turn add to the same row. A resumed conversation shows the row too, as
the event is kept in the session journal. To remove one, use `/memory delete
<name>` or pick it in `/memory`. The last part is why it went with the message:
the small model's own words (`covers the cache lifetime`) or `matched words`; with
`memory.select: off` there is none.

### How a memory is chosen for a message

The words of your message find up to 16 candidates. The small model then reads
the message, the assistant's last line and one line per candidate (its title,
description, type, age and who wrote it, never the body) and names up to three that would
clearly help, or none. This happens once per message, before the first model
call of the turn, with a limit of two seconds; the tool steps that follow reuse
the answer. Memories the conversation already holds are not offered again.

When there is no small model to ask, it is too slow, or it answers something
unreadable, Namzu falls back to the words alone, and then a memory must share at
least two words of your message (one is no longer enough). The model is never
the conversation's own: when the small-model route would resolve to the main
model (see [the small model](small-model.md#which-model)), nothing is asked.

Set `memory.select: off` in your own config to keep the earlier behaviour
exactly: the words alone, up to three memories, one shared word enough.

```yaml
# ~/.namzu/config.yaml
memory:
  select: off   # default: on
```

Privacy: with `memory.select` on, the small model sees your message and the titles
and descriptions of the candidate memories, sent to your own provider (the small
model is one of that provider's, or the `smallModel` you set). It sees no memory
body. A project's `namzu.config.json` (or the local file), including a profile in it, cannot
set `memory.select`; only your own config and a managed config can. One line per selection goes to the log with
counts, the reason a fallback happened (`none`, `no side model`, `main route`,
`timeout`, `invalid`, `error`) and the time taken; it holds no message or memory
text.

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

The project's curated `MEMORY.md` is never changed, at launch or by
`/memory import-notes`. When it holds top-level bullets (`- text`) — some may be
notes `#note` used to append there, and nothing can tell those from bullets you
wrote — the launch says how many and offers `/memory import-notes`, once per
curated file (the checkout's file and a subdirectory's own `.namzu/MEMORY.md`
are offered separately). The bullets stay curated and reach every turn as
before.

`/memory import-notes` copies every top-level bullet into a `project` memory
named after it, whatever surrounds it: a heading's list, with or without a
blank line under the heading, is copied like any other. Only a bullet's first
line is copied; nested bullets, prose and headings are not. The file is read,
never written: the report says it is unchanged, and deleting the bullets you
no longer want read into every turn is yours to do. Running it again copies
nothing twice: a bullet already stored — by an earlier import, as a `#note`
with the same text, under its own name with the same text, or as a copy you
archived — is counted as already stored and skipped. A `migration.json` in the
stored-memory directory records, per curated file, when it was offered and
imported, so a later launch does not offer it again. `~/.namzu/MEMORY.md` and
`USER.md` are never touched.

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

The default promoter writes useful extracted claims to this store when a turn
settles, tagged `session:<id>` and `turn:<id>`. `compaction.consolidate: true` selects consolidation instead, so the CLI
does not run both writers. Writing remains separate from curated file appends
and from read-only recall; disabling recall does not disable writes. A turn whose
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
