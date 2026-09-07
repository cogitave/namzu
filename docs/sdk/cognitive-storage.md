---
type: Design
title: Cognitive storage research
description: Pinned Pydantic AI storage findings and a proposed architecture for bounded local recall, durable evidence and recoverable execution.
resource: packages/sdk/src/store/memory/disk.ts
tags: [sdk, research, cognition, memory, storage]
status: draft
---

# Cognitive storage research

This draft extends the [cognitive architecture](cognitive-architecture.md).
The database and caching design below is a proposal, not shipped Namzu behavior.
Storage supplies evidence and execution records; neither persistence nor a
retrieval score establishes truth or demonstrates biological learning.

The comparison inspected Pydantic AI core at
`b61fa91eb75df968b1b6d355d3da8363639408aa` (2026-09-06) and its separate
`pydantic-ai-harness` repository at
`d004ad6a308c0cc88efc7b1b4b3913147e794424` (2026-09-05).
Links to source below pin those revisions; documentation links describe the
official documentation consulted on 2026-09-07.

## Current Namzu costs

[DiskMemoryStore](../../packages/sdk/src/store/memory/disk.ts) reloads and
validates its complete JSON index under an exclusive operation lock for every
operation, including reads. A nonempty query selects status/tag candidates
without a result limit, reads their complete bodies into a map, then tokenizes
and ranks them. Limiting returned entries does not bound those reads or RAM.
Mutations rewrite the index; content and index writes are separate operations.
The lock coordinates cooperating processes but does not make both files one
crash-atomic transaction. See [structured memory](memory.md).

For many candidates, the resulting cost includes file opens, JSON parsing,
retained body strings and repeated tokenization. Disk caches may reduce physical
reads without removing parsing or allocation. An HDD may amplify file-access
latency; that is an engineering expectation requiring measurement, not a measured
Namzu result.

## Pydantic separates four responsibilities

| Component | Responsibility and boundary |
| --- | --- |
| `Memory` | Cross-run Markdown notebook with read/write/search tools. PostgreSQL is an actual notebook backend. |
| `ConversationSearch` | Lexical retrieval over persisted conversations, including retained pre-compaction originals. |
| `StepPersistence` | Events, continuable message snapshots and a tool-effect ledger; not complete execution-state restoration. |
| DBOS | Workflow/step checkpointing and recovery, independently backed by PostgreSQL or SQLite. |

The notebook capability resolves scope in application code and refreshes a
bounded user-role memory block before a model request, removing its previous
injection. On-demand retrieval can replace automatic injection. Its snapshot
loading is a durable operation, but durable execution does not persist an
otherwise in-memory notebook.
[Memory capability source](https://github.com/pydantic/pydantic-ai-harness/blob/d004ad6a308c0cc88efc7b1b4b3913147e794424/pydantic_ai_harness/memory/_capability.py)

PostgreSQL notebook writes combine expected-revision checks and operation
receipts in a transaction. Repeating an operation returns its recorded result;
reusing its identifier with different arguments conflicts. Sequence-generated
revisions distinguish successive writes. These mechanisms prevent lost updates
and duplicate mutations, not incorrect claims.
[PostgreSQL source](https://github.com/pydantic/pydantic-ai-harness/blob/d004ad6a308c0cc88efc7b1b4b3913147e794424/pydantic_ai_harness/memory/_postgres.py)

Conversation recovery unions complete snapshots in order using hashes of
serialized messages and suffix/prefix overlap, preserving repeated messages
at distinct positions. Earlier originals remain recoverable only while the
relevant snapshots survive.
[History source](https://github.com/pydantic/pydantic-ai-harness/blob/d004ad6a308c0cc88efc7b1b4b3913147e794424/pydantic_ai_harness/conversation_search/_source.py)

Step persistence distinguishes complete and interrupted snapshots. A tool
started without a terminal record has an uncertain outcome after a crash;
replay must not assume its effect failed. Bundled step stores are memory,
file, SQLite and MongoDB; PostgreSQL requires a custom adapter here.
[Step persistence documentation](https://pydantic.dev/docs/ai/harness/step-persistence/)

DBOS registers typed model, toolset and capability operations as named steps,
encoding and decoding their results. Ordinary function-tool I/O needs explicit
durable wrapping; MCP communication has its own wrapped operations. Model
stream events are buffered across the workflow boundary, while handlers inside
a step can receive live events and require idempotent effects.
[Backend source](https://github.com/pydantic/pydantic-ai/blob/b61fa91eb75df968b1b6d355d3da8363639408aa/pydantic_ai_slim/pydantic_ai/durable_exec/dbos/_operation_backend.py),
[DBOS documentation](https://pydantic.dev/docs/ai/capabilities/durable_execution/dbos/)

History processors offer a separate context-assembly boundary; the returned
history replaces the request's messages. Keep originals elsewhere when pruning.
Typed serialization validates representation, not provenance or authorization.
[Processor source](https://github.com/pydantic/pydantic-ai/blob/b61fa91eb75df968b1b6d355d3da8363639408aa/pydantic_ai_slim/pydantic_ai/capabilities/process_history.py),
[message documentation](https://pydantic.dev/docs/ai/core-concepts/message-history/)

Deferred external tools resume from saved history and results matched by
tool-call ID, normally in a new run within the same conversation. This provides
a boundary for releasing resident execution state during external waits.
[Deferred tools documentation](https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/)

## Bound input work as well as output

Pydantic's PostgreSQL notebook search fetches bounded content prefixes for
namespace paths, then ranks them in Python. It does not use a database text or
vector index. With default scan/read limits, the fetch can include 1,001 files
of 65,536 characters: approximately 65.6 million characters despite a small
returned excerpt. This is a configured maximum, not an observed workload.
[PostgreSQL source](https://github.com/pydantic/pydantic-ai-harness/blob/d004ad6a308c0cc88efc7b1b4b3913147e794424/pydantic_ai_harness/memory/_postgres.py),
[memory limits](https://pydantic.dev/docs/ai/harness/memory/)

Conversation search rebuilds its corpus from cumulative snapshots per call;
restoring snapshots can also fetch media unused by text ranking. Snapshot
retention reduces storage but can remove the only remaining pre-compaction
originals. Small search output therefore does not imply cheap input processing.
[Conversation search documentation](https://pydantic.dev/docs/ai/harness/conversation-search/)

## Proposed storage architecture

Persist immutable episode/message records once. Append execution events and
store continuation checkpoints as record references plus necessary state.
Separate note revisions, artifact blobs, tool-effect receipts and rebuildable
index projections. A checkpoint identifies a recovery point; it is not the
sole archival copy of an observation.

Use a local SQLite backend as a proposed single-device implementation and an
optional PostgreSQL adapter for shared deployments. Neither is shipped by this
proposal. Both should atomically commit revisions, mutation receipts and index
updates, or record a durable projection offset for eventual indexing. Expose
index lag rather than silently presenting stale search as complete.

Maintain a persistent lexical index. Retrieve scoped candidate IDs first,
page selected bodies, then load only the bounded adjacency needed for
association. Keep a byte-bounded working set in RAM. Store large artifacts by
content hash and resolve their bytes only when needed. Apply explicit retention
and reference-aware collection; deleting a checkpoint must not delete a blob
still used by an episode.

Cache validity and evidence validity are separate. Cache keys include scope,
record revision and indexing configuration; query caches also include query
and budget. An unchanged cached build result can remain accurate about revision
A while being inapplicable after revision B. Recheck status, permissions,
environment and relevant time constraints before using recalled evidence.

Measure bytes read, records scanned, index lag, lock wait, peak RAM, parsing
time and cold-cache latency alongside retrieval quality. Compare against the
existing store before claiming improvements. These are engineering adaptations
of inspected mechanisms, not neuroscience-derived storage requirements.

## Executable storage probe

`research/cognition/storage-probe.mjs` compares the built `DiskMemoryStore`
with a small contentless SQLite FTS5 index and separate payload table. The
fixture has 128 records in the selected scope, 64 matching records elsewhere,
4 KiB bodies and three selected matches. It checks identical matching IDs,
scope filtering before the limit, term updates and archive/reactivation in both
implementations. See the [recorded validation](../../research/cognition/VALIDATION.md).

Counters measure decoded bodies materialized by the application, not physical
disk traffic or SQLite index-page reads. The indexed query uses different
ranking semantics and lacks a production adapter's recovery and concurrency
contract. Candidate limits alone do not cap database execution work, especially
for frequent terms; production needs query budgets and measured cancellation.

This probe uses synchronous `node:sqlite` on Node 24. A production local backend
must preserve Namzu's supported runtimes and keep blocking database work away
from the agent's event loop, for example through a bounded worker. Timing out
the caller without stopping the worker would not enforce its resource budget.
