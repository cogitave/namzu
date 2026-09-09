---
type: Reference
title: Structured memory
description: Durable records, lexical search, lifecycle tools and bounded optional recall into a model request.
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
`DiskMemoryStore({ baseDir })` persists them beneath `<baseDir>/memory/`, with
an index and individual content files. A fresh instance or another cooperating
process reads the same records when given that directory. Each operation reloads
the disk index rather than relying on a previous process-local snapshot.

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
| `search_memory` | Searches active records by default; `status: 'archived'` inspects archived records. Returns titles, summaries and IDs, with a default limit of 10 and an allowed range of 1–50. |
| `read_memory` | Reads a complete record by its returned ID. |
| `save_memory` | Creates a historical claim with a useful title, summary and body. |
| `update_memory` | Corrects supplied fields or changes status; refuses an empty update. |
| `delete_memory` | Permanently removes a record; declared destructive for the host's tool policy. |

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

The block labels its contents as untrusted historical claims, includes record
IDs and update times, and includes a source run when recorded. This framing is
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
claim sections, and `verification: 'unverified'`. The promoter trims claims and
removes exact duplicates within a category. If the same ordered claim sections
already exist with matching tags and digest, it skips saving them again, even
when the prior record is archived. That lookup followed by creation is
best-effort deduplication, not a cross-process uniqueness guarantee. Paraphrases,
reordered claims and contradictions are not reconciled automatically.

The CLI uses promotion by default. Its explicit `compaction.consolidate` option
selects consolidation into the same store instead of running both writers.
SDK hosts configure promotion and consolidation separately. Neither writing
mechanism enables recall by itself, and neither turns an extracted claim into
verified current state. [Pinned facts](pinned-facts.md) and the run's
[working set](salience-working-set.md) have different retention lifetimes.
