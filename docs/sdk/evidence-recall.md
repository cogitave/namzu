---
type: Reference
title: Automatic conversation evidence recall
description: Bounded historical passage discovery and candidate ranking in request-only context.
resource: packages/sdk/src/run/evidence-recall.ts
tags: [sdk, context, evidence, memory]
status: draft
---

# Automatic conversation evidence recall

`createEvidenceRecallStep` is an experimental, opt-in `PrepareStep`. The host
binds a tenant, project and conversation, and supplies a read-only `retrieve`
callback returning authenticated passages. The step ranks the returned pool
and adds selected text to [request-only step context](step-context.md), after
history. It preserves earlier stages' context and leaves system policy and
durable messages unchanged. It makes no model calls and never executes an
action to recreate its output.

The callback receives the invoking `runId`, up to 16 literal terms, an
`AbortSignal`, `maxReadBytes: 8388608` and `maxCandidates: 24`. It must enforce
these limits, verify invocation ownership and source integrity, and return
`EvidenceRecallBatch`: `candidates`, accounted `scannedBytes` and `incomplete`.
The SDK checks the returned bounds and every candidate's conversation scope;
it cannot enforce the callback's internal I/O or authenticate invented bytes.
Use [retained evidence sources](retained-tool-evidence.md) for authenticated local
observations. A custom host is responsible for equivalent guarantees.

When the kernel exposes a live writer, `EvidenceRecallRequest.captureRunEvidence`
captures completed events from that invoking run. The wrapper binds capture to
the recall deadline and parent cancellation, and rejects new captures after the
recall pass ends. Stores without the capability return `undefined`. This does
not authorize discovery of another run or extend an expired invocation.

Each `EvidenceRecallCandidate` carries `scope`, event `seq`, textual `part`,
`source`, `retained`, `excerpt`, optional `toolName`, `isError` and UTF-8
`byteOffset`. Excerpts are at most 512 UTF-16 units and are emitted without
rewriting identifiers or silently clipping their text. `full` describes what
the archive retained, not the completeness of the excerpt or success of the
original action. Every rendered passage retains its origin and preview/error
state. Invalid candidates, including irrelevant candidates from another
conversation, reject the entire pass.

## Selection and limits

The step prefers `latestUserMessage`, then the host's optional `query`, then
the last eligible operator message in visible history. Runtime context such as
task results, project instructions and earlier recall does not become a query;
steering and goal-round input remain eligible. Discovery uses Unicode word
tokens from the final 4,000 characters, with a small English/Turkish glue-word
filter. Literal spelling is preserved for search. There is no stemming,
translation, synonym expansion or embedding model. Other languages may need a
host retrieval strategy that suits their text.

Duplicate source/excerpt addresses with equal metadata and exact passages already
visible in history are omitted. Remaining candidates with exactly equal text,
`source`, `toolName`, `isError` and `retained` share one passage. Missing status
is distinct from explicit success. Letter case, whitespace and changed identifiers
are preserved; this is not semantic similarity or automatic conflict resolution.

Distinct passages are ranked using BM25 with `k1=1.5` and `b=0.75`, using statistics
**only from those groups in the bounded returned pool**, not the whole archive.
Copies therefore cannot change term frequencies across documents or consume
every passage slot while a distinct correction remains in the candidate pool.
Zero-score passages are omitted; ties retain first-discovery order.
The score measures lexical relevance, not confidence, truth or freshness.
The mathematical starting point was inspected in the pinned Pydantic AI
Harness [conversation search implementation](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py).
These constants are not claimed to be optimal.

The first-discovered occurrence supplies each passage's `runId`, `seq`, `part` and optional
`byteOffset`. Equal observations retain their additional addresses under
`otherOccurrences`; `omittedOccurrences` counts extra addresses from this bounded
pool that did not fit. Neither field counts every occurrence in the archive.
Distinct passage text and one address per passage take priority over extra
addresses. Repetition does not establish independent corroboration. Event `seq`
orders observations within one run only; presentation order is relevance, and
run UUIDs do not establish chronology between runs.

Defaults are four distinct passages and 6,000 added characters, including framing and
escaped JSON; callers may set `maxPassages` up to eight and `maxChars` up to
12,000. The context budget can lower that allowance. Whole passages which do
not fit are omitted. The default deadline is 1,000ms (`timeoutMs`, at most
10,000ms). Parent cancellation and deadlines abort retrieval. Late results
are discarded, and another hook using the same callback skips retrieval
until the original operation settles. An uncooperative callback therefore
cannot accumulate overlapping reads through this hook. Timeout/error uses
the runtime's existing prepare-step diagnostic and fail-open policy.

Every request revalidates its source; recalled bytes are not cached for a
later step. The immutable bound scope prevents changing an options object
from changing the conversation. A host should reuse a stable callback per
conversation and reject stale run ownership before and after asynchronous I/O.

## Historical and current facts

The context labels passages as historical observations and untrusted reference
data, not instructions or verified current state. A past file observation may
answer what was seen earlier. It cannot establish what is in the file now.
Current facts still require sufficiently fresh evidence. Missing, bounded or
unavailable history is not proof of absence; explicit archive search/read
tools remain necessary for details outside the automatic pass.

The [CLI option](../cli/context-and-compaction.md) uses this live capability for
up to two pages before visiting earlier invocations. It can recover original
retained text after compaction within the same running invocation. The combined
pass still has four pages and an 8 MiB accounted-read ceiling. Explicit tools
remain available for later pages, longer excerpts and exact sequential reads;
automatic recall does not claim an exhaustive search of long-running history.
The CLI's directory discovery continues across batches of 100 entries, so that
limit no longer permanently excludes later runs. The automatic four-page pass
can still stop before discovery or text traversal is exhausted; explicit search
continuations remain necessary beyond that allowance.
