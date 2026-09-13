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
durable messages unchanged. By default it makes no model calls. Optional query
resolution uses run-metered inference; retrieval never executes an action to
recreate its output.

The callback receives the invoking `runId`, up to 16 literal terms, an
`AbortSignal`, `maxReadBytes: 8388608` and `maxCandidates: 24`. It must enforce
these limits, verify invocation ownership and source integrity, and return
`EvidenceRecallBatch`: `candidates`, accounted `scannedBytes` and `incomplete`,
with optional `excludedToolResults`.
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

Set `resolveQuery: true` to resolve conversational references before retrieval.
The default remains `false`. With the kernel's optional
[`generateText` preparation capability](step-context.md#bounded-preparation-inference),
a tool-free call asks the selected model whether the current question is
self-contained, refers to previous text, or needs no search. This addresses the
[observed referential failure](../../research/conversation-evidence/referential-results.md);
the [follow-up CLI trials](../../research/conversation-evidence/resolved-query-results.md)
record two exact historical answers and one remaining current-answer spelling
failure. This is not a guarantee that the model understands every reference.

Planning receives only the current question (at most 1,000 UTF-16 units) and up
to six eligible visible operator/assistant text messages, each truncated to its
last 600 units. History selection examines at most 64 entries before the current
operator boundary; tools, private reasoning, project policy and runtime task
context are excluded. If the six newest eligible messages are all assistant
updates, the same 64-entry scan continues looking for the nearest preceding
operator request. When found, that request replaces the oldest selected update:
the planner still receives at most six messages of at most 600 units each. This
prevents progress commentary from disabling reference resolution while its
operator request is still inside the scan allowance. It does not restore a
request removed by compaction or enlarge the history scan.

When the retained `latestUserMessage` is the same object as a visible message,
that message locates the boundary. A retained input can instead live outside
the visible array, as with tool-result steering or checkpoint hydration. In
that case the planner considers the bounded recent visible history, without
mistaking an older equal string for the new input. This view is not guaranteed
to precede the original acceptance time: no missing position is invented from
text or timestamps. Hosts without retained-input metadata keep the existing
text boundary fallback.

It requires an operator message in that selected history. Missing inference,
missing prior context or longer questions keep literal retrieval. The planner
cannot discover a referent that is absent from this bounded visible history.
The [progress-heavy CLI comparison](../../research/conversation-evidence/query-history-results.md)
records a false current-file answer, exact historical recovery after selection
was fixed, and later query-planner failures, using separate reopened CLI processes.

A contextual plan supplies at most 16 non-whitespace search terms and three
exact quotes of at most 200 units each. Filenames and hyphenated identifiers are
split using the same word tokenizer as candidate discovery. The expanded set
must still contain at most 16 tokens; no unknown token is silently discarded.
Every resulting token must occur in the current question or a cited quote, and
each quote must occur verbatim in the supplied history. This normalizes search
units only, never source text or a model's final answer. The
resulting `queryResolution` metadata records terms, temporal interpretation and
quoted message positions within that preparation history. These are references
to visible conversation, not authenticated archive addresses or proof of truth.
They share the existing added-context character allowance. Grounding validates
spelling and source inclusion, not semantic relevance.

Self-contained or new-topic plans keep the current literal query. Present-state
plans never expand with historical terms; fresh source observations remain the
main model's responsibility. A `none` plan skips optional recall. Malformed or
ungrounded plans reject the optional stage through its existing fail-open
diagnostic; the main task and explicit archive tools remain available. The
previous operator query is never used just because literal retrieval was empty.

One plan promise is cached for the same run and operator-message identity, also
keyed by question text. New runs or steering input invalidate it. A failed plan
is not retried on every iteration. Evidence bytes are still retrieved and
revalidated on every pass. This cache is local to the hook, not durable memory.
The planning call permits at most 512 output tokens and ten seconds, sharing the
run's provider chain, token ledger and cancellation. Those tokens count toward
the run; the subsequent retrieval deadline is separate. These are bounded
preparation costs, not free retrieval or a hard provider billing ceiling.

Duplicate source/excerpt addresses with equal metadata are omitted. Exact passages
already visible in history or an earlier stage's `prepared.system`/`prepared.context`
contribute quoted source references instead of new passages. Tool text blocks
have the same visibility behavior as string-valued messages. Each text block is
checked independently: joining blocks would invent visible text across their
boundaries. Image/document payloads, filenames, media types and private reasoning
do not establish textual visibility. Earlier context is preserved and still
counts against the runtime's remaining budget; it is not added to durable history.

This is visibility at this preparation boundary, not a guarantee about later
stages or provider transformations. Visibility grants no archive authority:
every candidate, including visible text, still passes the full scope and metadata
validation. Available references retain their exact quotes, error/preview status
and recording times. Visible text no longer consumes a new-passage slot just
because its message uses the block form. The [CLI comparison](../../research/conversation-evidence/visible-blocks-results.md)
records missing evidence displaced by that representation mismatch.

Remaining candidates with exactly equal text,
`source`, `toolName`, `isError` and `retained` share one passage. Missing status
is distinct from explicit success. Letter case, whitespace and changed identifiers
are preserved; this is not semantic similarity or automatic conflict resolution.

Known derived summaries (`source: 'compaction_shed:summary'`) are ranked after
other matching records. Each group uses its own bounded BM25 statistics, so
repeated summary vocabulary cannot change the source records' scores. This
orders only the discovered candidate pool; it does not search extra pages or
establish which claim is true. Summaries can still fill remaining passage slots,
are used when they are the only matching candidates, and retain omitted read
addresses. Visible source references use the same ordering. Explicit archive
search remains unfiltered. Older unmarked summaries are not guessed from prose.
The [CLI comparison](../../research/conversation-evidence/summary-evidence-results.md)
records the case where four derived summaries displaced a retrieved original.

If a partial CLI discovery page includes known summaries, the host may spend
its existing refinement page on the same terms with
`excludeDerivedSummaries: true`. This changes source selection before passage
slots are consumed, allowing retrieval to traverse repeated summary records.
It retains the general cursor and already returned summaries, so a summary-only
archive can still contribute evidence. When the focused scan finishes, any
remaining pages resume the general cursor. This takes the place of lexical
term refinement for that source class; it does not add another scan or page.
The combined four-page and 8 MiB limits remain. Large excluded spans can still
exhaust discovery; the focused and general continuations remain distinct.

Optional `EvidenceRecallBatch.excludedSummaries` carries nonnegative safe-integer
scan-visit counts into bounded context with source-selection guidance, even when
no passage is returned. It is not a unique-fact count or proof of absence. The
[CLI discovery experiment](../../research/conversation-evidence/summary-discovery-results.md)
compares the previous twenty-summary failure and verifies recovery past seventy
summaries, including an empty filtered index page.

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
Already visible exact text is suppressed from new passage text, but its validated
sources appear separately in `visibleEvidence`. Each entry binds its exact bounded
`textQuote` (at most 512 UTF-16 units) to a directly readable `address` (`runId`, `seq`, `part`, optional `byteOffset`), optional
`recordedAt`, `source`, optional `toolName`/`isError`, and `retained`. The quote
repeats only the authenticated candidate excerpt needed to make the association
explicit; it does not reload the full source or establish that a
preview is complete. Matching text may occur in several visible messages, so the
list is not a mapping to their order. Read an entry's `address` with the host's
archive tool for text beyond the quote.

Visible candidates are ranked separately so they do not change new-text BM25
statistics. Positive-score candidates are grouped by the existing exact-copy
rules, then equal quote/reference metadata is deduplicated. One representative per distinct
quote is offered before extra occurrences, so copies cannot consume the whole
reference allowance ahead of a distinct visible correction. Visible quoted references
and new passages share `maxPassages`; new text takes priority. Extra references
can therefore be omitted even if characters remain. `omittedVisibleEvidence`
counts references from this bounded pool that did not fit, not total historical
occurrences. Source time, error and retention remain distinct; missing metadata
is not filled in from visible text. References are revalidated each pass, even
when similar metadata was previously visible. Quoted references themselves add no current-state assertion; optional query
resolution labels an interpretation separately.
Quoted references do not validate a model's final free-form answer. The
[visible-source CLI experiment](../../research/conversation-evidence/visible-evidence-results.md)
records both the improvement over unquoted references and an unresolved exact-code
copy error from a live low-effort model.

The [recorded CLI comparison](../../research/conversation-evidence/recorded-time-results.md)
checks both date orders with a small model at low effort.

Distinct passages are ranked using BM25 with `k1=1.5` and `b=0.75`, using statistics
**only from those groups in the bounded returned pool**, not the whole archive.
Copies therefore cannot change term frequencies across documents or consume
every passage slot while a distinct correction remains in the candidate pool.
Zero-score passages are omitted; ties retain first-discovery order.
The score measures lexical relevance, not confidence, truth or freshness.
The mathematical starting point was inspected in this pinned
[conversation search implementation](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py).
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

The CLI's automatic discovery excludes successful `search_conversation` and
`read_conversation` outputs before they occupy candidate slots. These tools quote
archived observations; repeated successful retrieval is not another observation
of the original state. This host policy uses the SDK's generic
`excludeSuccessfulTools` source option; the SDK does not hardcode CLI tool names.
Errors and unknown source/status remain. Compacted results are identified only
when the SDK can pair the call and response unambiguously in that same record;
older archives without paired metadata and legacy unindexed compaction text
remain unknown. This is not semantic deduplication: unknown or differently
rendered quotes can still occupy candidate slots.

A retrieval callback may report nonnegative safe-integer `excludedToolResults`.
The step validates it and, when positive, includes the count and explanatory
guidance in its bounded context. Counts are scan visits, so a focused pass may
count the same record again. They are not unique facts or errors, and do not
replace `incomplete` or `omittedPassages`. An exclusion-only block can be returned
without passage text, within the same character ceiling. New explicit archive
searches remain unfiltered; automatic continuations retain their source filter.
The [CLI comparison](../../research/conversation-evidence/retrieval-echo-results.md)
measures a correction initially hidden behind retrieval copies, including the
compaction case, without claiming a general memory benchmark improvement.

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
addresses, visible-text source references, and extra addresses of selected exact duplicates. All share the
original character ceiling. An omission-only block is retained even if no whole
excerpt fits and source traversal was complete. A complete scan with no new text can still add visible-source references or their
omission counts. A scan with no eligible text, references, exclusions or traversal omissions adds no context; a context budget too small for the framing skips
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

When reporting a source identifier, its spelling must remain exact. A requested
text transformation produces a derived value instead: lowercasing a recorded ID
for display does not change the archived ID or establish new workspace state.
Recall guidance distinguishes these operations without rewriting retained text
or installing a generic answer-rejection policy. The [CLI copy/transform
experiment](../../research/conversation-evidence/copy-intent-results.md) records
natural-language failures and controls against falsely rejecting legitimate
transformations; these are bounded trials, not a general fidelity guarantee.

The [CLI option](../cli/context-and-compaction.md) uses this live capability for
up to two pages before visiting earlier invocations. It can recover original
retained text after compaction within the same running invocation. The combined
pass still has four pages and an 8 MiB accounted-read ceiling. Explicit tools
remain available for later pages, longer excerpts and exact sequential reads;
automatic recall does not claim an exhaustive search of long-running history.
Within one automatic candidate page, the CLI can cross completely searched
matching runs as well as empty runs, while respecting the shared byte and output
limits. Partially traversed SDK pages keep their continuation boundary. This
allows distinct evidence from several small invocations to enter the bounded
candidate pool instead of spending one automatic page on each run. It does not
expand the four-page budget or claim exhaustive archive coverage.

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
