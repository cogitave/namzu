# Candidate discovery and ranking use different matches

Measured 2026-09-12 against built revision `e1b8bc72`. This follows the failed
full-sentence fixture in [omission propagation](omission-results.md).

## Observed mechanism

`createEvidenceRecallStep` extracts Unicode letter/number/underscore sequences
from operator text, removes its small glue-word list, and asks the host for a
bounded candidate pool. The CLI discovers those candidates using literal
substring matches. Final BM25 ranking counts complete lowercased tokens.

For example, the retained query term `in` matches `Packing information` during
discovery but contributes zero frequency to its tokenized ranking. Enough such
matches consume the live source's eight-candidate allowance before `DELTA` is
visited. Filtering or ranking only after that allowance cannot recover an
observation absent from the candidate pool.

## Source comparison

The pinned Pydantic AI Harness
[ranking implementation](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py)
uses one tokenizer for query and documents and ranks its selected corpus before
choosing results. Its materialized corpus is a different resource contract from
Namzu's bounded archive discovery; this inspection is not a runtime comparison.

Manning, Raghavan and Schütze's
[tokenization chapter](https://nlp.stanford.edu/IR-book/html/htmledition/tokenization-1.html)
explains why query and document tokenization must agree, while also describing
the complications of technical names and languages without word separators.
Their [stop-word discussion](https://nlp.stanford.edu/IR-book/html/htmledition/dropping-common-terms-stop-words-1.html)
shows how discarding common words can remove meaningful distinctions. Those
principles support testing consistent matching rather than assuming a longer
denylist fixes retrieval.

Lucene's [BM25 API](https://lucene.apache.org/core/10_3_1/core/org/apache/lucene/search/similarities/BM25Similarity.html)
defines frequency weighting using corpus statistics. Namzu's current scores use
only its bounded candidate pool; they must not be presented as global archive
relevance or calibrated confidence. No BM25 tuning was changed in this study.

## Bounded ablation

The [reproducible script](candidate-alignment.mjs) uses the actual built SDK for
term extraction, literal matching and final selection. Each synthetic corpus
has eight distinct distractor records followed by one target. Candidate output
is capped at eight and final output at one passage. The word-boundary alternative
is a full-string prototype, not a shipped kernel feature.

| Case | Current discovery | Add `in`/`this` to stop list | Token-aligned prototype | All nine candidates, reference |
| --- | --- | --- | --- | --- |
| Sentence: `in` inside `Packing information` | Miss | Hit | Hit | Hit |
| `code` inside `decoder` | Miss | Miss | Hit | Hit |
| `3` inside `13000` | Miss | Miss | Hit | Hit |
| `İZMİR` inside `İZMİRLİ` | Miss | Miss | Hit | Hit |
| `id_1` inside `id_100` | Miss | Miss | Hit | Hit |
| Frequent complete word `in` | Miss | Hit | Miss | Hit |

These six deliberately adversarial examples establish failure modes, not a
representative success rate. The all-nine reference remains within the SDK's
24-candidate contract and demonstrates that its scorer can select these targets
if discovery includes them. It does not propose reading an unbounded archive.
There are no model calls, CLI/TUI rendering assertions, throughput measurements
or new archive reads in this ablation. Module fingerprints remained unchanged.

## Implementation decision and remaining work

Do not ship a larger stop list as the complete fix. It helps two examples while
leaving the non-glue and identifier cases unchanged. Likewise, token alignment
alone still lets a frequent whole word exhaust a bounded page.

The next implementation needs an optional retrieval mode whose candidate
matching and scoring share the same token and case rules, without narrowing
ordinary explicit literal search. Cursor identity must bind that mode across
live, closed and legacy sources. A chunk boundary needs authenticated preceding
text: the current spill window starts at the chunk and cannot prove whether its
first character begins a word. Applying a boundary regex there directly would
produce incorrect matches. Any extra authenticated read must remain charged
against existing byte and cancellation limits.

After that, evaluate bounded candidate allocation across query terms so common
terms do not monopolize the pool. Preserve rare numeric and technical identifiers
and test common-word counterexamples; merely increasing page limits would hide
the selection problem. Record the before/after natural CLI fixture separately
from these synthetic controls before claiming a user-visible improvement.
