# Uncovered query terms in bounded evidence discovery

Measured 2026-09-12 on Linux/WSL. Baseline revision: `7bb81631`.
This follows the [whole-word counterexample](candidate-alignment-results.md)
left after [token alignment](token-discovery-results.md).

## Evidence and design

A shared tokenizer removed substring pollution but not candidate starvation by
complete words: twelve separate `in` matches can consume the first four indexed
pages without visiting a later original `DELTA` record. Ranking the returned
pool cannot promote a record that discovery never included.

Santos, Macdonald and Ounis's
[WWW 2010 xQuAD paper](https://archives.iw3c2.org/www2010/publications/santos10pdf.pdf)
explicitly models query aspects and the coverage/novelty of a selected ranking.
Agrawal et al.'s
[WSDM 2009 work](https://www.microsoft.com/en-us/research/publication/diversifying-search-results/)
also treats diversity as an objective alongside relevance. These are primary
sources for considering uncovered needs, **not algorithms implemented verbatim
here**. Namzu's change is a bounded lexical heuristic for candidate discovery;
words are not semantic aspects and no xQuAD probability or approximation
bound is claimed.

The locally inspected Pydantic AI Harness
[BM25 source](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py)
tokenizes its materialized document corpus before ranking. Namzu retains its
separate bounded-source contract. This is source inspection, not a comparative
runtime benchmark or a claim that this implementation is better overall.

The pure SDK helper `refineEvidenceRecallTerms` forms unique lowercase query
keys Q, observed excerpt-token keys C, and U = Q \ C. It returns a query only
when 0 < |U| < |Q|, retaining the first original spelling and order. Inputs are
bounded to 16 terms of 256 characters and 24 excerpts of 512 characters. There
is no embedding call, query expansion, new stop list or corpus-wide statistic.

The CLI uses at most one such refinement each for the active writer and earlier
invocations. A new focused scan spends a page from the same four-page allowance;
at most two pages visit the active writer. Both scans share the 8 MiB ceiling,
and rereads are charged again. The original broad cursor remains available.
When focused scanning finishes, remaining pages continue the original query.
Up to four read-only hints preserve their individual query, scope and omissions.
Completing a subset cannot make pending broad traversal exhaustive.

## Production CLI experiment

[The script](refined-discovery-cli.mjs) creates an isolated synthetic closed-run
archive: twelve distinct whole-word `in` distractors precede an oversized retained
observation containing two fresh random UUIDs beyond its preview. Ordinary
conversation history contains only a summary; the workspace file contains a
replacement with neither original identifier.

The natural prompt is: **“What were the tracking code and destination in the
original DELTA observation?”** Actual SDK query extraction is used. Both raw
literal and raw token source scans still miss the target within four indexed
pages: the improvement comes from allocating a page to uncovered terms.

The production `run --resume` CLI is invoked with evidence recall enabled,
`gpt-5.6-luna`, `low` effort, a 20,000-token admission budget, four iterations
and a 90-second deadline. A preload records only temporary evidence context.
Scripted controls return that context; the live trial forwards provider calls
unchanged. The baseline control used the old built modules before source edits.

| Trial | Original in first request context | Accounted read bytes | Requests | Tool calls | Tokens |
| --- | --- | ---: | ---: | ---: | ---: |
| Baseline, scripted | No | 77,617 | 1 | 0 | 0 |
| Refined, scripted | Yes | 486,856 | 1 | 0 | 0 |
| Refined, Luna/low | Yes | 486,856 | 1 | 0 | 7,299 |

The live answer contained both exact identifiers and ended with `end_turn`.
Ordinary history had neither identifier, and the replacement file was unchanged.
All trials retained an incomplete broad-search continuation. Module fingerprints
were stable during each trial. [Recorded results](refined-discovery-results.json)
contain synthetic data and fingerprints, not credential or system-prompt dumps.

This uses **more I/O**, because it reaches and authenticates the full original
instead of stopping among early distractors. It is not a disk-read saving,
paired-model cost benchmark or representative retrieval success rate. The live
subscription usage is unpriced, not proof of zero monetary cost. This was a
real headless CLI run over a synthetic prior archive, not a new live compaction
or TUI visual test.

## Validation and limits

New tests exercise original recovery from active, closed and legacy sources;
four simultaneous broad/focused continuations; exact shared-byte accounting;
empty-subset completion returning to the original cursor; numeric/identifier
terms; Unicode case distinctions; duplicates; and bounded invalid input. The
existing real Session tests for compaction, resume, changed artifacts and foreign
scope also pass. No historical state-changing tool action is replayed.

Workspace tests passed: **6,380 SDK tests**, **2,866 CLI tests**, five CLI tests
skipped, and the other workspace packages passed. SDK process tests: **257 passed**.
Typecheck, build, lint, docs,
fence compilation, exported signatures and SDK test presence passed. Lint still
reports 35 existing SDK warnings and 14 existing CLI warnings. No push, publish,
release-only coverage, consumer-install or package-shape gate is claimed.

Remaining limitations are explicit: an excerpt pool covering every query token
will not be refined; a still-frequent uncovered term can dominate its own page;
a single-term query has no strict subset; and the deadline or byte ceiling can
end discovery early. The heuristic does not resolve contradictions, semantic
aliases or query intent. Explicit archive continuations remain necessary beyond
the automatic allowance. These are further evaluation targets, not claims of
completed autonomous-kernel intelligence.
