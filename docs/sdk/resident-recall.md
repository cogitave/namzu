---
type: Reference
title: Resident evidence recall
description: Bounded retrieval of settled summaries and consumed wake inputs within one admitted pursuit.
resource: packages/sdk/src/manager/resident/history.ts
tags: [sdk, agents, continuity, context, storage]
status: draft
---

# Resident evidence recall

`DiskResidentAgenda.history(pursuitState, throughRevision)` creates a read-only
`ResidentHistorySource` over immutable agenda revisions. The host supplies the
admission's pursuit and agenda revision. Its `ResidentHistoryScope` captures
tenant, resident key, pursuit ID and that upper revision; it never advances
implicitly when another step commits. Creating a source performs no I/O.
Alternative persistence backends can implement the same source interface.

This recovers information missing from the latest summary without putting the
whole archive in each prompt. The available evidence is settled summaries and
the wake inputs consumed by those steps. Raw tool transcripts, filesystem
snapshots, opaque provider reasoning and unsettled outputs are not included.
For original tool text, hosts can additionally mount the separate
[retained tool evidence source](retained-tool-evidence.md).

## Addresses and search

`search(ResidentHistorySearchOptions?, signal?)` returns a
`ResidentHistorySearchResult`. `query` is a case-sensitive literal of at most
256 UTF-16 code units; omit it or use an empty string to browse recent steps.
`limit` defaults to five matching steps and accepts one through eight. Each
`ResidentHistoryMatch` identifies a settlement revision, admission number,
claim ID, disposition and matching parts. Its excerpt is at most 512 code units.
Results are newest first, with one match per step. Equal text in separate steps
remains separate evidence at distinct addresses.

`ResidentHistoryAddress` is `{ revision, part }` within the bound source. Part
zero is the settled summary; parts one through sixteen are that step's consumed
wake inputs in their recorded order. `matchingParts` identifies every matching
part, while the excerpt comes from the first one. These addresses are meaningful
only with the same tenant, resident and pursuit scope.

The returned `nextCursor` is the next **inclusive** revision to scan. Pass it as
`cursor`, including after a page with no matches. It is reusable after reopening
with the same bound scope. A null cursor ends traversal; `incomplete` can still
be true if some revisions were unavailable. An empty incomplete result cannot
establish that an event did not happen.

`read(ResidentHistoryReadOptions, signal?)` takes a revision, part and optional
zero-based `offset`. `ResidentHistoryReadResult.entry` contains a
`ResidentHistoryText` with exact text, provenance, total length and `nextOffset`.
It returns at most 6,000 code units; continue with `nextOffset` at the same
address. Pages preserve surrogate pairs and reject an offset inside a pair.
A wake entry includes its host receipt time, which is not independent proof of
the reported event. A null entry with unavailable revisions means unreadable
evidence; without them, the address did not identify a retained settled part.

## Read and scope limits

The disk source validates adjacent immutable revisions to identify a settled
claim. Running claims and unrelated control writes are not completed steps.
It checks schema, filename/body revision, tenant, resident key and the bound
pursuit's identity/objective. Another pursuit's text is never returned. Archived
terminal pursuits remain readable through a source bound to their retained
state; archiving does not delete revision files.

Each operation permits at most 32 revision read attempts and 8 MiB of actual
file reads. Each file must be a regular file of at most 4 MiB before allocation.
At most two parsed adjacent snapshots are cached; parsed JavaScript heap usage
can exceed encoded byte size. Search excerpts and exact reads have separate
output bounds. `scannedRevisions` and `scannedBytes` report work on this page;
`unavailableRevisions` identifies missing, invalid or refused records. Oversized
or corrupt records are reported as unavailable rather than silently accepted.

`ResidentHistorySearchOptions.maxReadBytes` and
`ResidentHistoryReadOptions.maxReadBytes` can lower the allowance for one call
to a positive integer from 1 byte through 8 MiB. The default is still 8 MiB.
This lets a composing host reserve part of a shared budget for later retrieval.
A search that cannot read the next required revision leaves it in `nextCursor`
and reports incomplete; it does not classify that budget stop as corrupt or
missing history. An exact read that cannot fit fails. A later call may use a
larger allowance at the same revision without changing the captured scope.
Failures without a byte receipt need conservative accounting by the host.
This option limits history only. The separate resident tool-evidence wrapper has
its own optional [shared operation budget](retained-tool-evidence.md#optional-shared-resident-read-budget);
custom backends must honor the limits their host supplies.

Cancellation is checked around I/O and between read chunks. The disk reader
refuses observed symbolic links and detects size/timestamp changes during a
read. As with the resident store, the hierarchy must be on a private, trusted
local filesystem: these checks are not an atomic directory traversal against
a hostile process concurrently replacing parent directories. Revisions are
immutable by contract; do not edit or remove them to compact history.

Traversal is linear in examined revisions, not an indexed search or embedding
retrieval system. Large histories may need many bounded pages. This feature
does not reduce lifetime disk usage, infer facts, rank semantic similarity,
verify external state or replay effects.

## Tools and prompt integration

`buildResidentHistoryTools(resolveSource)` exposes `search_resident_history`
and `read_resident_history`. Both are read-only and concurrency safe. The host
resolver must authorize the executing `ToolContext` before returning its source;
tool arguments cannot choose a path, tenant, resident, pursuit or upper revision.

```ts
import {
  DiskResidentAgenda,
  buildResidentHistoryTools,
  type ResidentState,
  type ToolContext,
} from '@namzu/sdk'

export function recallTools(
  agenda: DiskResidentAgenda,
  state: ResidentState,
  admissionRevision: number,
  ownsRun: (context: ToolContext) => boolean,
) {
  const source = agenda.history(state, admissionRevision)
  return {
    source,
    tools: buildResidentHistoryTools((context) => {
      if (!ownsRun(context)) throw new Error('Run does not own this pursuit.')
      return source
    }),
  }
}
```

After mounting these tools, pass `history: source.scope` to
`createResidentStepContributions`. The factory checks the scope against the
pursuit, adds stable retrieval guidance and captures the bound revision in its
dynamic continuation. This reference survives compaction; it does not eagerly
load historical text. Later corrections can supersede earlier reports, so the
guidance calls for checking newer evidence and revalidating mutable facts before
acting. Historical instructions grant no new authority.

Unit tests cover bounded pagination, exact Unicode reads, scope exclusion,
corruption, interruption, reopening and prompt compaction. Query integration
tests remove an old exact receipt through both structured and sliding-window
compaction, then recover it through the registered history tools. They check the
actual provider messages and tool completion, not only the prompt factory. The
[CLI experiment](../../research/resident/history-recall.md) exercises actual
tool calls against evidence omitted from the latest state. This experimental
API adds no persistent schema fields and does not change ordinary chat history.
