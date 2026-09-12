# Distinct historical evidence under repetition

Measured 2026-09-12 on Linux/WSL. Automatic recall previously deduplicated equal
source addresses, then ranked each remaining observation independently. Four
copies of one short receipt at different event positions could fill its four
passage slots while a longer correction in the same retrieved pool was excluded.
This is an information-selection defect; increasing the model's effort would
not restore a passage missing from its request context.

## Source comparison and decision

The pinned Pydantic AI Harness [conversation-search code](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py)
was read locally. Its dependency-free BM25 ranks persisted messages, using
statistics from the selected corpus. Namzu already used the same BM25 constants
over its smaller, bounded candidate pool. That lexical score alone does not
allocate space between repeated and distinct observations.

Carbonell and Goldstein's primary [MMR paper](https://www.cs.cmu.edu/afs/cs/Web/People/jgc/publication/MMR_DiversityBased_Reranking_SIGIR_1998.pdf)
separates relevance from novelty in passage selection. It motivates checking
redundancy alongside relevance; this change **does not implement MMR**, copy its
evaluation scores, or claim an optimized novelty weight. A fuzzy similarity
penalty could suppress an almost identical correction that differs in one
important identifier. Namzu instead groups only exact equal text with matching
producer, retention and error metadata before computing bounded BM25 statistics.

Each group preserves one primary source address and the remaining distinct
addresses as `otherOccurrences`. Distinct passage text is allocated before extra
addresses; `omittedOccurrences` accounts for addresses that cannot fit. Equal
text does not establish equal events, independent corroboration, current truth
or global chronology. Different errors, previews, unknown status, producers,
letter case, whitespace and identifiers remain separate.

## Reproduction and CLI measurement

The [reproducible CLI script](diversity-cli.mjs) records five synthetic historical
tool events: four identical observations with an unpredictable old UUID, followed
by a longer correction with a different UUID. The ordinary conversation holds
only a summary, and the current workspace receipt is absent. It invokes the
production CLI `run --resume` with automatic evidence recall enabled. A preload
observes provider inputs; `--live` forwards the real provider without supplying
its decisions, while the control returns the actual prepared context verbatim.

Prompt: **“DELTA kaydındaki ilk ve son takip kodunu söyler misin?”**

| Run | Mode | Selected passage text | Correction in context | Added context characters | Tokens |
| --- | --- | --- | --- | ---: | ---: |
| Previous build | Scripted control | Four copies of old receipt | No | 1,462 | 0 |
| Updated build | Scripted control | Old receipt + correction | Yes | 1,540 | 0 |
| Updated build | Live Codex, gpt-5.6-luna, low | Old receipt + correction | Yes | 1,540 | 7,158 |

The live run returned both exact UUIDs in one request with `end_turn`, zero tool
calls, unchanged workspace content and unchanged built-module fingerprints.
Three additional addresses preserve all four old observations. The new context
is slightly longer because it also contains the correction, source addresses
and more explicit framing; this is improved distinct coverage, not a measured
token saving. Token pricing was unavailable (`unpricedTokens: 7158`), so the
reported zero currency total does not establish a free request.

Before/after fixtures use the same text template and query but different random
UUIDs. This is a controlled reproduction, not a same-byte archive comparison or
a model benchmark. The initial control used “önceki ve düzeltilmiş …”; the old
ranker already surfaced the correction because “Önceki” matched it. That attempt
failed the script's expected-missing assertion and remains in the raw report.
It establishes query dependence, not a retrieval failure for every paraphrase.
The final neutral prompt was set before the fix and used unchanged afterward.

## Validation and limits

SDK regression tests cover duplicate flooding, invariance of passage ranking to
added equal observations, exact small differences, producer/error/preview
separation, foreign duplicate scope rejection, character accounting and bounded
source omissions. A real CLI Session test records the observations through the
SDK writer, projects only a summary, then creates a fresh Session. It verifies
both passages arrive in request-only context and each duplicate address still
returns the original text through paged conversation reads.

Workspace typecheck, build, lint and tests, SDK process tests, docs conformance
and fence checks are recorded in the accompanying JSON report. Release-only
coverage, package-consumer and publish checks are not claimed by this milestone.
No release or push was performed.

This short live run did not trigger compaction; the existing Session compaction
tests remain the evidence for that separate path. Recall stays opt-in. It still
searches a bounded pool (24 candidates, four CLI pages, 8 MiB), and cannot select
a correction that discovery never reached. This change does not summarize an
entire archive, resolve conflicting claims automatically, order different runs
by time, or establish parity with another harness.
