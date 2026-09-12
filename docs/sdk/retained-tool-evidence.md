---
type: Reference
title: Retained tool evidence
description: Bounded indexed retrieval of original tool text across explicitly authorized resident invocations.
resource: packages/sdk/src/store/evidence/disk.ts
tags: [sdk, context, continuity, storage, tools]
status: draft
---

# Retained tool evidence

`createDiskRunEvidenceSource(DiskRunEvidenceOptions)` binds a `RunEvidenceSource`
to one closed invocation. The host supplies `scope` (tenant, project, Session
and run UUIDs), `runDir` and `indexDir`. It does not discover or authorize runs.
The source checks `run.json.metadata.scope`, the run ID and terminal status
before reading its transcript or creating an index. This invocation scope is
recorded by `RunPersistence`, independently of a shared ancestor token account.
An old record without explicit scope is unavailable; no ownership is guessed.

`search` accepts an optional case-sensitive literal `query` of at most 256
UTF-16 code units and an opaque `cursor`. An empty query browses tool records.
Each result contains its scope, up to four matches, `nextCursor`, actual
`scannedBytes`, `indexedRecords`, `cacheHit`, `incomplete` and `unavailable`.
Matches identify the event sequence, tool name, `isError`, retained-text status,
an excerpt of at most 512 code units, an opaque `address` and a UTF-8
`byteOffset`. Event order is preserved within an invocation. Equal text from
different tool completions remains distinct. A long result can match in more
than one search window; this is not an exhaustive list of occurrences.

`read({ address, byteOffset? }, signal?)` returns exact retained text, at most
6,000 code units, together with `totalBytes` and `nextByteOffset`. Start at the
match's byte offset or zero, then use the returned continuation offsets. Pages
preserve UTF-8 characters and surrogate pairs; an offset inside a character is
refused. Offsets refer to retained output, not the current workspace file.

Always follow `nextCursor`, even after an empty page. A null cursor means this
traversal ended, not that missing or partial evidence became complete. Sources
that changed or cannot be authorized are refused; individual unavailable tool
records are reported on search pages. A preview's negative search cannot prove
that the missing part contained no match. `full` describes retained text, not
binary images, documents, provider reasoning, current external state or success
of the historical action. Check `isError` separately.

## Retention and integrity

The model-visible output cap remains 40,000 characters by default. Oversized
permitted tool text is retained before its preview is produced. Post-tool hook
replacement/redaction happens before retention. A fresh run resolves its output
directory when the tool executes, after the store initializes; it no longer
captures a permanently empty directory during query construction.

Alongside `tool-output/<sha256(toolUseId)>.txt`, retention writes a private,
exclusive `.txt.manifest.json` sidecar. Its SHA-256 is recorded in the additive
`tool_completed.outputSpillIntegrity` field. The version-one manifest contains
the UTF-8 byte length, 64 KiB chunk hashes and literal-search filters. Reading a
selected window verifies the manifest and each selected chunk, without hashing
the entire large output again. Search filters include a 1 KiB overlap for
queries spanning chunk boundaries. Filters can have false positives; matching
text is always checked against verified bytes. This is literal retrieval, not
semantic ranking or an embedding memory.

The reader derives the artifact path from the authorized invocation and tool
ID. It never follows an arbitrary `outputSpillPath` in an event. Older truncated
records without an integrity manifest expose only their recorded preview. A
missing or changed authenticated spill is unavailable, never silently replaced
with a preview presented as the original. Retention/manifest failures do not
fail the tool: it still returns its bounded preview, with degraded recovery.

## Durable index and work bounds

Index pages retain event offsets, lengths, sequence numbers, record hashes and
literal-search filters. They validate consecutive transcript sequence numbers,
run identity and the initial `run_started` event. Each page indexes at most 64
records and 4 MiB of transcript input. The first search builds needed pages;
later searches and process restarts reuse them. Negative filters avoid reading
irrelevant bodies. Short or common queries can still require linear traversal;
the number of bounded pages can grow with the archive.

One run-source call reads at most 8 MiB, including metadata and index files.
`run.json` is limited to 512 KiB; one transcript record and one spill manifest
are each limited to 4 MiB. Manifests accept at most 4,096 chunks; the encoded
manifest limit can be reached earlier. Oversized/torn records are refused.
Reading is chunked with cancellation checks. Parsing expands encoded bytes in
JavaScript memory, so these are I/O/allocation bounds, not exact heap limits.

Private index pages, cursors and addresses are authenticated with a persistent
per-scope key and bound to the source file stamp and metadata digest. Changed
sources invalidate old cursors. Damaged cache pages are rebuilt from the
source; deleting the index also invalidates its addresses and requires a new
search. Concurrent first readers publish one complete key atomically. The host
may discard the derived index; it is not the primary evidence store. There is
no automatic index-generation garbage collector.

The index directory's parent must exist and be private and host-owned. The
source can create the final index directory after checking ownership. Observed
symlinks, non-regular files and source changes during reads are refused. As with
resident history, this is a trusted local filesystem contract, not atomic
protection against a hostile process replacing ancestor directories. Hashes
detect changed selected bytes; they do not establish that a tool's claim was
true or that every unselected chunk is still present.

## Resident and host integration

`createResidentToolEvidenceSource({ history, projectId, resolveRun })` combines
the disk/backend interface with a bounded `ResidentHistorySource`. The latter
verifies settlement in adjacent agenda revisions before `resolveRun` receives
a `ResidentSettledInvocation` identity. The host then validates that claim's
execution receipt and returns its explicitly authorized `RunEvidenceSource`.
The wrapper checks tenant/project agreement. It admits neither current running
claims, other pursuits nor steps beyond the captured upper revision.

Each resident search page examines at most one invocation, newest settled step
first. It carries `revision`, `claimId`, the run-level `evidence` result and a
resident continuation cursor. History scanning has its own 32-revision/8 MiB
bound, reported as `historyBytes`; this is in addition to the run-source bound.
Missing attempt bindings mark the revision unavailable and allow traversal of
earlier history. Reads reauthorize the settlement and attempt on every call.

`buildResidentToolEvidenceTools(resolveSource)` mounts `search_resident_tools`
and `read_resident_tool`. The host must validate the executing `ToolContext`
before returning its source. Tool arguments select no filesystem path, tenant,
project, pursuit or arbitrary Session. After mounting these tools, pass
`toolEvidence: true` to `createResidentStepContributions`. Stable retrieval
guidance survives compaction; it does not eagerly attach past outputs. Ordinary
chat and delegated children acquire no access from this option implicitly.

```ts
import {
  createDiskRunEvidenceSource,
  type DiskRunEvidenceOptions,
} from '@namzu/sdk'

export async function findRetainedReceipt(authorizedRun: DiskRunEvidenceOptions) {
  const source = createDiskRunEvidenceSource(authorizedRun)
  let page = await source.search({ query: 'receipt' })
  let incomplete = page.incomplete
  while (page.matches.length === 0 && page.nextCursor) {
    page = await source.search({ query: 'receipt', cursor: page.nextCursor })
    incomplete ||= page.incomplete
  }
  const match = page.matches[0]
  return match
    ? source.read({ address: match.address, byteOffset: match.byteOffset })
    : { incomplete }
}
```

The SDK exports the scope, source, options, result and address-related types
used by these factories. Alternative stores implement `RunEvidenceSource`;
the core does not import the CLI. The [CLI binding](../cli/resident-work.md)
adds its own attempt/Session checks. [Verification notes](../../research/resident/tool-evidence.md)
separate deterministic execution tests from the live small-model experiment.
