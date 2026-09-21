---
type: Reference
title: Structured memory
description: Durable typed records — one Markdown file per memory or JSON — with a generated index, lexical search, lifecycle tools and bounded optional recall into a model request.
resource: packages/sdk/src/types/memory/index.ts
tags: [sdk, memory, storage, retrieval]
status: stable
---

# Structured memory

`MemoryStore` holds historical records for later use. Saving a record, finding
it in search and adding it to a model request are separate operations. SDK hosts
choose their store, register the tools they permit, and opt into automatic recall
through `prepareStep`. The CLI makes those choices for its project scope; its
[curated markdown files](../cli/memory.md) are a separate memory surface.

## Store and scope

`InMemoryMemoryStore` keeps records in the current instance.
`MarkdownMemoryStore({ directory })` keeps one Markdown file per memory in that
exact directory, with a generated `MEMORY.md` index beside them (see
[Markdown memory files](#markdown-memory-files)).
`DiskMemoryStore({ baseDir })` persists them beneath `<baseDir>/memory/`, with
a JSON index and individual content files. A fresh instance or another
cooperating process reads the same records when given that directory. Each
operation of either disk store reloads what is on disk rather than relying on a
previous process-local snapshot.

The host owns isolation. `MemoryStore` methods do not take a tenant, project or
session ID, and a metadata tag does not enforce access control. Bind the store
to the authorized scope before exposing it to tools or recall. The CLI uses the
project's state directory, so separate sessions in that project share records.

| Operation | Result |
| --- | --- |
| `create(params)` | New active record, returning index entry and content with an opaque memory UUID. |
| `list(params?)` | Matching index entries and `totalCount` before the result limit. |
| `get(id)` | Full content, format and optional metadata, or `undefined`. |
| `getRecord?(id)` | Current `{ entry, content }` snapshot, or `undefined`. |
| `update(id, updates)` | Updated index entry, or `undefined` when absent. |
| `delete(id)` | Whether the record existed and was removed. |

### Typed fields

`MemoryIndexEntry` and `CreateMemoryParams` carry three optional fields:

| Field | Meaning |
| --- | --- |
| `name` | Unique kebab-case slug (`[a-z0-9]+(-[a-z0-9]+)*`, at most 64 characters, never `memory`). Another memory links to it as `[[name]]`. |
| `description` | One line saying what the memory is for, used to judge relevance without reading the body. |
| `type` | `user` (who the operator is), `feedback` (a rule the operator gave, with why), `project` (a fact or decision the code and its history do not already say) or `reference` (where to look). |

Records written before these fields existed have none of them, and all three
stores read such records unchanged. Every shipped store refuses a `name` another
record already holds with `MemoryNameConflictError` — a `NamzuError` with code
`storage_error` whose `existingId` names the holder — so a caller updates that
record instead of writing a second one. A malformed name, type or multi-line
description is refused with `invalid_config` before anything is written. Search
scores a name like the title and a description like the summary.
`DiskMemoryStore` stores the fields in its JSON index; an older build that
rewrites that index drops them, because an index whose top level is an array
carries no version stamp to refuse on.

`UpdateMemoryParams` accepts the optional fields of `CreateMemoryParams` plus
`status: 'active' | 'archived'`. Omitted fields retain their existing values;
supplied tags or metadata replace that field. Archiving retains the record for
explicit inspection, and setting `status: 'active'` reactivates it. Direct store
`list()` includes both statuses unless filtered. Direct reads can also retrieve
an archived record. Deletion removes the store record, not earlier transcripts
or copies made by callers.

Both shipped stores implement optional `getRecord`. They read metadata and body
together at one operation boundary and return a defensive copy. This lets a
caller recheck the current status after a search selected an older entry. It does
not reserve that record against a later update or make a sequence of separate
store calls into one transaction. Custom stores can implement this optional
method to provide the same snapshot contract.

### Markdown memory files

`MarkdownMemoryStore` writes each memory as `<name>.md`:

```markdown
---
name: tests-need-a-built-sdk
description: The CLI tests import the SDK dist, so build it first
type: feedback
status: active
createdAt: "2026-09-21T09:30:00.000Z"
updatedAt: "2026-09-21T09:30:00.000Z"
tags: ["testing"]
id: 0b6c2a4e-6d0f-4c7e-9a51-3f2d8e1b7c40
---

Run pnpm -r build before the CLI tests.

Why: the CLI resolves the SDK through its built exports.
How to apply: after any SDK change, before trusting a CLI failure.
```

`name`, `description` and `type` are required in a file. `status` defaults to
`active`; `createdAt` and `updatedAt` default to the file's modification time;
`id` defaults to a stable id derived from the name, written down at the next
update. `title`, `summary`, `format` (default `markdown`) and `metadata` appear
only when they differ from those defaults, so an operator can write a memory
file by hand with the first three keys and a body. `create` without a `name`
derives one from the title — at most 32 characters, cut at a word boundary, so
the index line keeps room for the description — and suffixes it (`-2`, `-3`)
until it is free; with a `name`, a taken one is refused as above. Updating
`name` renames the file.

The frontmatter reader implements a deliberately small part of YAML: plain
scalars, double-quoted JSON values (strings, arrays, objects), single-quoted
strings and block lists. A value opening with `[` or `{` that is not JSON is
read as a plain string, so `description: [WIP] deploy notes` works; a field
that needs a list or an object (`tags`, `metadata`) then refuses it by type.
An unknown or repeated key, a block scalar, an unterminated `"` string, a name
that differs from its file name, two files claiming one id with the same
`updatedAt`, a symlinked or non-regular file, a file over 256 KiB
(`MEMORY_FILE_MAX_BYTES`), a NUL byte, invalid UTF-8, or a file stamped with a
newer `schemaVersion` fails the operation with a `storage_error` naming the
file, rather than presenting a smaller store as complete.

The store never writes what it would refuse to read. `create`, `update` and
`importRecord` refuse a body containing a NUL character, or a record whose file
would exceed 256 KiB in UTF-8, with `MemoryContentRejectedError` — a
`NamzuError` with code `invalid_config` and `reason` `'too_large'` or
`'nul_byte'` — before anything is written. `save_memory` and `update_memory`
return that as a failed result. Other files
in the directory — the generated index, `operation.lock`, a retired
`content.migrated/` — are ignored, with one exception: while a
`DiskMemoryStore` `index.json` is present, every operation except
`importRecord` is refused with a `storage_error` naming it, because that index
holds records this store cannot see and answering without them would present a
smaller memory as the whole. Import its records, then move `index.json` aside.

Files are written by atomic rename with mode `0600`; the directory is created
`0700`. Operations take the same `operation.lock` as `DiskMemoryStore` (below),
so the two never interleave on one directory. A rename writes the new file
before removing the old one, and an update's `updatedAt` is always later than
the one it replaces. A crash between the two writes leaves two files claiming
one id with different `updatedAt`: the store reads the newer, and the next
write moves the older aside to `<name>.md.superseded` rather than deleting it.
Two files with one id and the same `updatedAt` — a copied file — are refused by
name.

`MEMORY.md` is regenerated after every write: a header comment, then one line per
active memory, sorted by name, as `- [name](name.md) — description`, each line
at most 150 characters (`MEMORY_INDEX_LINE_MAX_CHARS`): the description is
clipped to the room the link leaves, and dropped when a name near the 64-character
limit leaves less than two characters. It is never read back; editing it has no effect, and
a hand edit to a memory file reaches it at the next write.
`readIndex({ maxLines })` renders the same lines from the current files for a
prompt, capped at `maxLines` (default `MEMORY_INDEX_MAX_LINES`, 200) with a final
line saying how many more memories exist and to use `search_memory` for them.
`renderMemoryIndex(entries, { maxLines })` is the same rendering over any
entries. The host decides where the index goes in its prompt.

`importRecord(record, { type })` brings in a record from another store keeping
its id, timestamps, status and metadata. It is idempotent by id — a record
already present is reported `present` — and suffixes a taken name rather than
failing, so an interrupted migration can simply run again. `getByName(name)`
returns the record under a name, archived included.

### Disk coordination and recovery

Disk operations, including reads, acquire `<baseDir>/memory/operation.lock`
using exclusive file creation. The lock contains a PID, unique owner token and
acquisition time. Release checks ownership before removing it. This serializes
operations across cooperating processes on a local filesystem and prevents
successful concurrent writers from overwriting each other's index additions.
Read access therefore also requires permission to create and remove the lock.

`lockTimeoutMs` defaults to 10,000 and must be a positive safe integer. It bounds
waiting to acquire a busy lock, not the duration of the operation after acquiring
it. An occupied symlink or non-regular lock file is refused. A crashed process
can leave a lock behind: Namzu never removes one just because it looks old. The
`storage_error` diagnostic names the lock path and tells the operator to stop
all processes using the store and inspect its owner before removing a stale
lock. An owner mismatch during release is also an error.

This is cooperating-writer exclusion, not distributed coordination or a
crash-atomic transaction across the index and content files. An I/O failure or
crash between those writes can leave a partial update requiring recovery.
Do not run older writers that ignore this lock against the same directory.
Malformed indexes or indexed content fail visibly rather than being treated as
an empty store.

## Search

The built-in stores use deterministic lexical search over title, summary and
full content. Queries and fields are normalized with Unicode NFKC, lowercased
and split into letter/number terms. A record qualifies when any query term
matches; word order does not matter. Results rank by:

1. Number of distinct query terms matched.
2. Field score per matched term: title 8, summary 4, body 1. Repeating a term
   inside a field does not add score.
3. Most recently updated, then ascending memory ID for a stable tie.

For example, `cerulean-cache expiry` can find a body saying “cerulean-cache
expires after 14 hours” through the shared identifier terms. There is no
stemming, synonym expansion, embedding or semantic verification. Contradictory
records can both match. Disk searches read candidate bodies under the operation
lock; a result limit bounds returned rows, not the amount of content scanned.

`MemorySearchParams.requiredIdentifiers` optionally requires at least one exact
word-token match in ID, title, summary or body **before** ranking/limiting.
Both shipped stores normalize NFKC and lowercase, preserving underscores in
these identifier tokens. `quartz9` does not match `quartz90`. An empty array adds
no condition. `totalCount` counts only eligible results. A metadata-only
`MemoryIndex` cannot find body-only identifiers; the disk store loads bodies
before applying this condition. The condition does not make disk scanning
sublinear. Custom stores must implement this optional search contract to avoid
losing eligible results behind irrelevant top-k entries.

All requested tags must match. An empty or whitespace-only query lists records
by recency; a nonempty query containing no letter/number terms matches nothing.
Supply `limit` to bound direct store results; omitting it returns all matches.

`buildMemoryTools(store)` searches the authoritative asynchronous store.
The overload `buildMemoryTools(store, index)` instead makes the caller's
`MemoryIndex` authoritative for search, without loading or synchronizing it
through the store. The standalone `InMemoryMemoryIndex` holds only title and
summary metadata, so it cannot search body content. Hosts using a custom index
own its freshness and search semantics.

## Model tools and lifecycle

`buildMemoryTools` returns five tools. Register them in the host's `ToolRegistry`
to make these operations available to the model.

| Tool | Contract |
| --- | --- |
| `search_memory` | Searches active records by default; `status: 'archived'` inspects archived records. Returns IDs, titles, names, types, ages and descriptions (summaries where there is no description), with a default limit of 10 and an allowed range of 1–50. |
| `read_memory` | Reads a complete record by its ID or its name. For a `text` or `markdown` record, the output is the body followed by `---` and the date it was last updated with its age, the verification notice below when it is not from today, and each `[[name]]` link resolved to an ID and description or reported missing. A `json` record's output is its body exactly, still parseable; `data` carries `updatedAt`, `name`, `type` and resolved `links` for every format. |
| `save_memory` | Creates a memory with a title, summary and body, and optionally `name`, `type` and `description`. A taken name returns a failed result naming the existing ID and pointing to `update_memory`. |
| `update_memory` | Corrects supplied fields, including `name`, `type` and `description`, or changes status. Takes the record's ID or its name — what a prompt carrying the index shows. Refuses an empty update, an unknown name and a name another record holds. |
| `delete_memory` | Permanently removes a record; declared destructive for the host's tool policy. |

The `save_memory` description tells the model what belongs in a memory: what is
true now and cannot be worked out from the code, git history or files; for
`feedback` and `project` memories, the rule first, then a `Why:` line and a
`How to apply:` line; `[[name]]` links to related memories; and an update
instead of a duplicate.

Saving through the tool records `metadata.source: 'agent-memory'` and the
calling `runId`; updates preserve that creation metadata and modify only the
requested fields. The tool-call transcript records the updating run. These
identify origin, not truth. A direct store caller supplies its own metadata. Neither metadata
such as a claimed expiry time nor conflicting text triggers automatic deletion,
archiving or contradiction resolution. Correct or archive obsolete claims using
current evidence.

## Optional recall before a model step

`createMemoryRecallStep({ store })` returns a `PrepareStep` hook. Supply it as
`prepareStep` to `query` or `drainQuery`, or include it in an ordered preparation
chain. It preserves guidance from earlier stages and adds only an ephemeral
system block for the next request. The block is not appended to saved
conversation history. Explicit `read_memory` results remain ordinary tool
history and have their normal retention behavior.

Recall selects active records using meaningful terms from the latest operator
message in `PrepareStepContext.latestUserMessage`. The runtime carries that
message across compaction and replaces it when new operator steering arrives;
project instructions and task completion notifications do not become the recall
query. A checkpoint stores its text, timestamp and validated operator provenance
in `IterationCheckpoint.latestUserMessage`, without duplicating attachment bytes.
Resume refuses a malformed intent snapshot; older checkpoints without the field
fall back to surviving history. This is a host-policy input, not an extra copy
of the entire user message automatically inserted into every model request.
New operator arrivals queued for resume take precedence over the checkpoint's
older intent. Earlier surviving history does not overwrite a newer checkpoint.
Inbound messages and tool-attached steering also refresh the bounded task and
requirements extracted into working state, so its compaction summary can retain
the changed direction. Runtime worker reports do not become operator intent.
`options.query` is a fallback
when that runtime field is absent, followed by an eligible message still in the
history. Generic prompts such as “continue” do not list arbitrary memories.

Defaults are three records, 6,000 added characters including source labels and
framing, and a 1,000 ms deadline for the whole pass. `maxMemories`, `maxChars`
and `timeoutMs` accept positive safe integers. Available context headroom can
reduce the character allowance further through `contextBudget.remainingTokens`;
this uses the runtime's context estimate, not a tokenizer or billing guarantee.
If even the framing cannot fit, the hook skips recall without reading the store.

Each selected record is read again through `getRecord` when available, so a
record archived after selection is excluded and its current metadata accompanies
its current body. Custom stores without this method cannot promise the same
atomic snapshot. Edits, archiving and deletion are reconsidered on each step;
there is no persistent recall cache. An error or timeout is reported by the
runtime's preparation diagnostic and that request proceeds without this stage's
recalled context. The hook also observes the run's `signal` to stop waiting on
cancellation. A store call already in progress may finish after a timeout or
cancellation; its late result is not inserted into a later request. While an
optional recall is still outstanding, other recall hooks using the same store
object skip their pass. The slot is released only when the underlying pass
settles, including after errors. This prevents a timed-out read from accumulating
more optional reads on subsequent steps or runs. It does not cancel disk I/O,
coordinate separate store objects/processes, or throttle explicit memory tools.
No result is shared across callers; a later admitted pass uses its own current
query and reads fresh records.

Identifier grounding is opt-in through `MemoryRecallOptions.identifierGrounding: true`
(default false).
When enabled, recall extracts up to 32 mixed-letter/digit word tokens from the
last 4,000 query characters (for example `quartz9` or `worker_v2`). Tokens must
begin with a letter or underscore and contain both a Unicode letter and number.
Plain numbers and words do not activate this policy. It prioritizes these tokens
within the existing 32-term search budget and requires a match with **any** one
of them, so a comparison of two identifiers can retrieve records about either.

The hook supplies the store condition and rechecks each fresh record before
injection. A custom store that ignores the condition cannot inject a mismatched
record, but may fail to return a relevant record beyond its own result limit.
This is lexical grounding, not entity recognition or semantic relevance. Aliases,
renamed identifiers and alternative spellings can be missed. Shared versions
such as `v2` can still match unrelated records. Explicit memory tools retain
ordinary broad search and remain available to investigate such cases.

The block labels its contents as untrusted historical claims, includes record
IDs, names and types when present, update times, and a source run when recorded.
A description, when present, stands in for the summary. A record last updated
longer ago than `ageNoticeAfterMs` (default one day) also carries an `age` such
as `"12 days old"`, and the block then ends with `MEMORY_VERIFY_NOTICE`: memories
are point-in-time, so a file, function, flag or command one names must be
verified against the current code before it is relied on. The first aged record
pays for the notice out of the character budget; a block of fresh records spends
nothing on it. `now` overrides the clock. This framing is
not a truth check or a security boundary. Current instructions and fresh evidence
take precedence, and changeable facts need verification.

The CLI enables this hook by default. Set `memory.recall: false` in CLI
configuration to disable automatic recall while retaining the explicit tools.
SDK hosts opt in by supplying the hook.

### Exercise recall without a provider

This example invokes the same preparation hook directly, with no model or
network request. In an agent run the runtime supplies its context instead.

```ts
import {
  InMemoryMemoryStore,
  createMemoryRecallStep,
  createUserMessage,
  generateRunId,
} from '@namzu/sdk'

const store = new InMemoryMemoryStore()
const { entry } = await store.create({
  title: 'Cache configuration',
  summary: 'Recorded service setting',
  content: 'cerulean-cache expires after 14 hours',
})
const recall = createMemoryRecallStep({ store, maxChars: 2000 })
const context = {
  runId: generateRunId(),
  stepNumber: 1,
  messages: [createUserMessage('What is the cerulean-cache expiry?')],
  steps: [],
  prepared: {},
}

const prepared = await recall(context)
console.log(prepared?.system) // Includes the saved claim and its source ID.

await store.update(entry.id, { status: 'archived' })
console.log(await recall(context)) // undefined: archived records are excluded.
```

## Promotion after a run

`createMemoryPromoter({ store })`, supplied through `promoteMemory`, persists
useful extracted user requirements, decisions, discoveries, failures and
environment claims. It does not save a record for a candidate with none of those
claims. `maxPerCategory` defaults to 20. Summaries carry actual claims; the full
record also carries extraction omissions and files touched when present.

Promoted records carry the `run-memory` tag, source run, a digest of the selected
claim sections, `type: 'project'`, and `verification: 'unverified'`. The promoter trims claims and
removes exact duplicates within a category. If the same ordered claim sections
already exist with matching tags and digest, it skips saving them again, even
when the prior record is archived. That lookup followed by creation is
best-effort deduplication, not a cross-process uniqueness guarantee. Paraphrases,
reordered claims and contradictions are not reconciled automatically.

Consolidation (`consolidateInto`) deduplicates the same way. `consolidationEntry`
adds a `knowledge:<digest>` tag and `metadata.knowledgeDigest`, computed over the
run's decisions, discoveries and failures — not its run id or task — plus
`type: 'project'`. Before writing, the runtime asks `isConsolidated(store, entry)`
and skips the write, with no `memory_consolidated` event, when a consolidation
with that digest already exists, archived included. The same best-effort caveat
applies.

The CLI uses promotion by default. Its explicit `compaction.consolidate` option
selects consolidation into the same store instead of running both writers.
SDK hosts configure promotion and consolidation separately. Neither writing
mechanism enables recall by itself, and neither turns an extracted claim into
verified current state. [Pinned facts](pinned-facts.md) and the run's
[working set](salience-working-set.md) have different retention lifetimes.

Hosts that partition memory themselves can pass `directory` to
`DiskMemoryStore` to select the exact memory directory instead of
`baseDir/memory`. The default and record format are unchanged. Each directory
has its own index, content and operation lock.
