# Bounded multi-term evidence discovery

Measured 2026-09-12. This follows the failed
[natural-language recall experiment](natural-results.md). The next requirement
is to supply relevant historical candidates without making the model discover
every search operation itself. This change supplies the bounded discovery
primitive; automatic selection, ranking and context attachment remain open.

## Primary-source comparison

The pinned Pydantic AI Harness
[conversation search implementation](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py)
splits a query into Unicode word tokens, deduplicates them, computes BM25
scores over the selected message corpus and ranks positive scores. Its inverse
document frequency and length normalization require corpus statistics.

Namzu's authenticated evidence reader visits bounded pages and may have only
seen a fraction of the archive. It cannot label scores computed from a few
visited excerpts as corpus-wide BM25 ranking. It also previously needed one
literal scan per selected term. Repeating that for many terms multiplies
verified chunk reads and ownership checks.

The SDK now accepts either its existing literal `query` or an optional `terms`
set. Each verified text window is searched for all supplied literals together.
This is OR candidate discovery, in existing event/passage order, without a
ranking or automatic semantic-intent claim. It adds no model request and does
not change existing CLI or resident tool schemas.

## Contract

The input accepts 1–16 nonblank literals of up to 256 UTF-16 units each. Exact
duplicates and ordering do not affect membership. A sealed continuation binds
the canonical set and case sensitivity. It refuses a different set or a switch
to literal-query mode. A distinct term-cursor discriminator prevents older
readers from silently treating it as a browse cursor.

Term matching shares the existing per-operation I/O and match ceilings. Exact
case filters reject a window only if none of the terms may occur; insensitive
matching verifies the original text. Regex metacharacters are escaped. Mixed
term lengths do not produce repeated short matches already wholly shown by an
excerpt, while a long match crossing the excerpt boundary remains discoverable.
Exact byte/character offsets, source identity, cancellation, missing/changed
artifact reporting and live capture boundaries remain in force.

## Measurement on the original CLI artifact

The [measurement script](term-scan.mjs) reopens the original completed run from
the first live natural-language experiment. That CLI run retained the shipping
file before it was replaced. The source is narrowed to its original read event;
all three conditions use the same authenticated artifact and a warmed index.
The experiment supplies `DELTA`, `takip`, and `deposu` explicitly. It does not
claim to have extracted them automatically from the user's question.

| Operation | Calls | SDK-accounted bytes read | Original identifiers recovered |
| --- | ---: | ---: | --- |
| Three individual literal searches | 3 | 1,760,556 | Both |
| One search with the three terms | 1 | 586,852 | Both |

The combined search read one third as many accounted bytes on this artifact.
These are the SDK's bounded-read counters, including its metadata/index checks,
not OS disk I/O, latency, provider tokens or a general performance benchmark.
Both conditions inspected the full relevant source window set; different data,
case-sensitive filter hits and match-limit pagination can change the ratio.
No live model was called for this measurement.

[Results, exact excerpts and source fingerprints](term-results.json) retain
the measurement. To reproduce from a built checkout, first run
`node research/conversation-evidence/natural-cli.mjs` to produce a new isolated
fixture, then pass its reported result path to
`node research/conversation-evidence/term-scan.mjs /tmp/<fixture>/result.json`.
The search can write derived private index pages; it does not execute any tool
action or modify the workspace source to recover historical text.

Unit/integration tests cover mixed-length matches, literal regex characters,
Unicode chunk boundaries, case-sensitive filters, set membership changes,
canonical reordering, query-mode changes, input ceilings, altered retained
bytes, scoped live recapture and reopened closed sources. The process suite
also resumes a multi-term cursor in a different process and reads its exact
historical result.

Workspace typecheck, build, lint and tests passed, including 6,302 SDK tests
and 2,831 CLI tests (five CLI skips). All 256 SDK process tests passed. The docs
gate validated 68 pages and compiled 47 TypeScript fences plus 20 package
READMEs. Existing lint warnings remain. Release coverage, publication and a
new live-model success result are not claimed by this change.

This does not resolve the previous live source-selection failures. The next
layer must choose and rank candidates within an explicit total retrieval
budget, attach them as historical request context rather than current truth,
and pass the same unassisted historical/current-state conversation checks.

## Follow-up

The subsequent [automatic recall experiment](automatic-results.md) adds bounded
candidate ranking and request-context attachment. The earlier samples above
remain unchanged; they describe the implementation tested at that time.
