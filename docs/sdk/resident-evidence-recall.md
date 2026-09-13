---
type: Reference
title: Automatic resident tool evidence recall
description: Bounded request-only retrieval of original tool evidence across settled resident admissions.
resource: packages/sdk/src/manager/resident/evidence-recall.ts
tags: [sdk, residents, context, evidence, retrieval]
status: draft
---

# Automatic resident tool evidence recall

`createResidentEvidenceRecallStep` prepares historical tool excerpts for one
already admitted resident invocation. It uses the same bounded selection,
BM25 ranking, exact-text grouping and context rendering as
[conversation evidence recall](evidence-recall.md), with a separate authority
boundary. It does not pretend that earlier admissions belong to the current
conversation or enumerate arbitrary Sessions.

```ts
import {
  createResidentEvidenceRecallStep,
  type ResidentState,
  type ResidentToolEvidenceSource,
  type RunEvidenceScope,
} from '@namzu/sdk'

declare const state: ResidentState
declare const source: ResidentToolEvidenceSource
declare const scope: RunEvidenceScope
const prepareStep = createResidentEvidenceRecallStep({ state, source, scope })
```

The host supplies the admitted `state`, the current executor's four-field
`scope` and a [resident tool source](retained-tool-evidence.md). The state must
be running with a claim and match the source's tenant, resident key and pursuit;
the current project must agree. The source captures an agenda revision. That
boundary is never advanced by preparation. Calls from another run and changes
to the source's scope are refused. The host still owns admission, executor
lifetime and source integrity; this function cannot authenticate arbitrary
custom callback I/O.

The existing source checks settlement before resolving a historical invocation.
The CLI additionally validates start/finish receipts, cleanup and invocation
ownership. A finish receipt alone does not authorize an unresolved claim.
Earlier Session/run IDs, within-run event sequence, pursuit/revision/claim, opaque archive address and byte
offset remain attached to each selected record. The adapter does not invent a
text-part number for tool-only sources. Use `read_resident_tool` with the returned
`revision`, `address` and `byteOffset` for a longer exact read. This revalidates
the original archive rather than replaying a tool or rereading a mutable file.

## Query and provenance

Preparation selects literal words from the captured objective, ordered accepted
wake inputs and previous summary. Each field contributes at most its last 4,000
UTF-16 units. Categories take turns contributing words so a long objective or
summary cannot occupy all slots. Within wake inputs the newest accepted input
gets the first opportunity; `wakeIndex` preserves its original committed index.
Case-folded duplicates share a slot and retain their first selected spelling.
At most 16 words fit the source's 512-byte combined query/filter JSON allowance.
Words which cannot fit are omitted, not shortened or translated.

`querySelection` labels each selected word as `objective`, `accepted_wake` or
`derived_summary`. These are search inputs, not retrieved observations. A prior
summary can identify a subject without establishing that the summarized claim
was true. Current run chat text does not replace this admission snapshot;
resident wake inputs are admitted between steps, not mid-step steering.

This initial policy is local lexical selection. It makes no query-planning model
call, does not infer unnamed referents and is not a relevance guarantee. A word
outside the bounded field tails or chosen slots may be missed. Explicit search
and read tools remain necessary beyond automatic selection. Returned excerpts
are historical tool records, not current facts; errors/previews remain labelled.
A tool result may itself quote another claim. Exact repetitions are grouped,
not counted as corroboration. Distinct corrections retain distinct text and
addresses; ranking is not causal order or evidence that a correction is valid.

## Bounds, cancellation and recovery

One pass permits at most four source search pages, 24 candidates and 8 MiB of
charged document reads. The current disk source returns at most four matches
per page. Every request supplies its remaining byte allowance to the resident
source, covering history, the declared resolution document bound and archive
reads. A custom source must honor that bound and return `chargedBytes`.

The optional `excludeSuccessfulTools` contains host-selected exact tool names;
it excludes successful retrieval copies before they fill candidate slots.
Errors and unknown provenance are not excluded. This filter is not an authority
rule. Its serialized size shares the 512-byte query allowance. The CLI excludes
its four resident history/tool search/read tools from automatic discovery;
explicit browsing remains available.

Defaults are 6,000 added characters, four passages and a 1,000 ms deadline.
`maxChars` may be at most 12,000, `maxPassages` at most eight and `timeoutMs` at
most 10,000 ms. Earlier preparation context is preserved. Metadata, addresses,
escaped text and continuation hints all share this allowance. The runtime's
remaining context room can lower it. Insufficient framing room skips I/O.

Cancelled, late, foreign or malformed results do not enter model context. An
uncooperative pending read cannot accumulate more overlapping passes through the
same adapter. Failed preparation uses the existing diagnostic/availability-note
path and never includes raw backend errors. A later model iteration revalidates
the source; no recalled bytes are cached as durable facts.

An incomplete scan cannot establish absence. When traversal remains, the
context can carry `search_resident_tools({ cursor })`. Pass that opaque cursor
unchanged; the source retains token terms, filters, invocation position and
admission scope across reopening. A continuation which cannot fit the context
allowance is counted as omitted. Explicit archive tools can start a fresh,
bounded search. The callback never restores an in-flight process or replays
historical effects.

## CLI composition

Both `resident run` and `resident start`, under both context profiles, attach
this SDK preparation step to each fresh admitted Session. Ordinary chats and
delegated children do not gain resident archive authority. Set
`compaction.recallEvidence: false` to keep explicit resident archive tools without
automatic preparation. Resident execution still refuses checkpoint resume;
this preparation callback is not installed on the checkpoint-resume path.

See the [active implementation and experiment record](../../research/resident/automatic-recall.md)
for the distinction between scripted process checks and live model observations.
