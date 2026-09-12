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

An incomplete batch may include up to four `EvidenceRecallContinuation` hints:
`toolName` and a flat `input` object with string, finite number, boolean or null
values. Names are bounded to 128 characters, input keys to 64, entries to 16 per
call, and the combined JSON to 2,048 characters before escaping. Invalid hints
reject the pass. The host must mount read-only tools which validate ownership,
cursor lifetime and source integrity again on execution. A hint grants no new
authority, performs no tool call and keeps no source bytes alive.

When the kernel exposes a live writer, `EvidenceRecallRequest.captureRunEvidence`
captures completed events from that invoking run. The wrapper binds capture to
the recall deadline and parent cancellation, and rejects new captures after the
recall pass ends. Stores without the capability return `undefined`. This does
not authorize discovery of another run or extend an expired invocation.

Each `EvidenceRecallCandidate` carries `scope`, event `seq`, textual `part`,
`source`, `retained`, `excerpt`, optional `toolName`, `isError`, stored-event `recordedAt` and UTF-8
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

`recordedAt` is optional recorder wall-clock Unix milliseconds, not fact time.
Explicit callback values must be positive integer milliseconds within the JavaScript
Date range; omit unknown times rather than returning a zero sentinel. Invalid
values reject the batch. Built-in archive sources derive it from the validated
event, including on exact reads. Compaction copies carry the copy event's time;
no original observation date is invented. Clocks can differ or move backwards.

The representative passage and each included `otherOccurrences` entry preserve
their own recording times. Equal text still shares one passage and receives no
extra ranking votes. Time metadata shares the existing character allowance.
`additionalEvidence` remains a plain read address; reading it returns the time.
Already visible exact text is still suppressed even if its recording metadata
is absent from visible history. Use explicit archive search/read to recover that
metadata; automatic recall does not guarantee temporal coverage of visible text.
The [recorded CLI comparison](../../research/conversation-evidence/recorded-time-results.md)
checks both date orders with a small model at low effort.

Distinct passages are ranked using BM25 with `k1=1.5` and `b=0.75`, using statistics
**only from those groups in the bounded returned pool**, not the whole archive.
Copies therefore cannot change term frequencies across documents or consume
every passage slot while a distinct correction remains in the candidate pool.
Zero-score passages are omitted; ties retain first-discovery order.
The score measures lexical relevance, not confidence, truth or freshness.
The mathematical starting point was inspected in the pinned Pydantic AI
Harness [conversation search implementation](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py).
These constants are not claimed to be optimal.

Candidate discovery can limit ranking quality before scoring starts. The CLI
uses the SDK's optional token mode for automatic discovery, so `in` inside
`Packing` no longer consumes a match slot that the scorer would then reject.
Discovery and scoring share token units and lowercase keys. Host callbacks
choose their own retrieval semantics; a custom literal source can still have
this mismatch. Genuinely frequent whole-word matches can also consume the bounded
candidate allowance before a relevant passage is visited. A small
[candidate-discovery ablation](../../research/conversation-evidence/candidate-alignment-results.md)
records the original limitation and alternatives. Token alignment addresses
substring pollution, not arbitrary candidate ordering or global relevance.
Explicit literal search still supports substrings.

`refineEvidenceRecallTerms(terms, excerpts)` is an optional, pure SDK helper
for host discovery. It compares the same lowercase token keys in a bounded
excerpt pool with the original query terms and returns only uncovered terms,
preserving first spelling and order. It returns `undefined` if none or all of
the terms were observed; case variants do not create additional terms. It
accepts 1–16 single-token terms of at most 256 UTF-16 units each and 0–24 excerpts
of at most 512 units each; invalid input throws. It performs no I/O, model call,
semantic inference or archive-wide frequency calculation. Its coverage is of
these excerpts only, not proof that a query aspect is answered or absent.

The CLI may spend an already allocated page on this strict subset when the
broad search has a continuation. There is at most one focused scan for the
current writer and one for earlier invocations. A focused scan starts from the
beginning under the same scope, token matching, cancellation and shared byte
ceiling; its reads are charged again. If it completes while pages remain, the
host resumes the preserved broad cursor. Exhausting the subset cannot exhaust
the original query. This can reach a rare query term behind frequent-word
matches, but cannot guarantee globally optimal candidates; an excerpt pool
covering every query token will not trigger refinement. No stop words are added.
The [measured CLI comparison](../../research/conversation-evidence/refined-discovery-results.md)
records the recovery improvement, increased I/O and remaining counterexamples.

The first-discovered occurrence supplies each passage's `runId`, `seq`, `part` and optional
`byteOffset`. Equal observations retain their additional addresses under
`otherOccurrences`; `omittedOccurrences` counts extra addresses from this bounded
pool that did not fit. Neither field counts every occurrence in the archive.
Distinct passage text and one address per passage take priority over extra
addresses. Repetition does not establish independent corroboration. Event `seq`
orders observations within one run only; presentation order is relevance, and
run UUIDs do not establish chronology between runs.

The metadata retains `incomplete` even when no passage was selected, including
when all matches are already visible. An empty or bounded scan is not proof of
absence. Available continuation calls appear as `continuations`, with
`omittedContinuations` counting hints that did not fit the character allowance.
`omittedPassages` counts eligible distinct passage groups from this returned
pool which were not selected, either because of `maxPassages` or the character
ceiling. It excludes visible text, exact copies and zero-score groups; it is not
a count of all relevant records in the archive. `incomplete` still describes
source traversal, so it can be false while `omittedPassages` is positive.

When text is omitted, `additionalEvidence` contains as many representative
`runId`/`seq`/`part`/optional `byteOffset` addresses as fit; `omittedAddresses`
counts omitted passage groups whose address did not fit. These addresses reuse
the validated candidate scope, disclose no omitted text and grant no authority.
A host archive tool must revalidate scope and source on a later read. Their
order remains relevance, not chronology. SDK callers supply their own archive
read tools; the CLI accepts these addresses through `read_conversation`.
A [recorded CLI comparison](../../research/conversation-evidence/selection-coverage-results.md)
shows exact recovery of a matched receipt omitted by selection.

Distinct text takes priority over traversal hints, then omitted-passage
addresses, then extra addresses of selected exact duplicates. All share the
original character ceiling. An omission-only block is retained even if no whole
excerpt fits and source traversal was complete. A complete scan with no eligible
new text still adds no context; a context budget too small for the framing skips
recall altogether.

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

When traversal has another page, the CLI supplies up to four continuations:
focused before broad within the live writer, then focused before broad within
earlier invocations. Each keeps its own query and omissions. The model can pass its opaque `cursor` to
`search_conversation` without reconstructing the automatic multi-term query.
Automatic passes still revalidate from the beginning; the explicit read-only
continuation provides access beyond that bounded pass without an action replay.
