---
type: Explanation
title: Memory retrieval research
description: Research and code comparison behind recall admission and the next memory retrieval experiments.
resource: packages/sdk/src/run/memory-recall.ts
tags: [sdk, memory, research, retrieval]
---

# Memory retrieval research

Inspected on 2026-09-09. The immediate bottleneck is optional work admission and
scan cost, before introducing another model to choose memories.

## Confirmed in Namzu

`DiskMemoryStore.list` loads every candidate body for a nonempty query, under
its cooperating-process operation lock. A result limit is applied after ranking;
three returned entries can require scanning the whole active store. The lexical
ranker uses distinct-term coverage and field weights, not BM25 and not dense
retrieval. AgentIR's BM25 margin thresholds cannot be copied into this score.

`createMemoryRecallStep` times out its wait, but the MemoryStore contract offers
no cancellation signal. Before the admission fix, a later model step could
start another list operation while the old one remained outstanding. A slow
store could therefore accumulate optional reads despite the one-second deadline.

The fix admits at most one automatic recall pass per store object in this SDK
module instance. A busy pass is skipped, not queued or merged with another
query. Admission remains occupied until the underlying pass settles, even if
the original caller timed out or cancelled. A later pass reads fresh state.
Separate store instances/processes and explicit memory-tool calls are outside
this guard. A permanently stuck store suppresses later optional recall on that
object until it settles; there is no unsafe forced release masquerading as
cancellation.

Regression evidence: a new test failed on the previous implementation, then
passed with the fix. Ten subsequent hooks sharing the stalled store start no
additional list call. An unrelated store remains usable. Further tests cover
cancellation while reading a body, release after errors, and fresh content after
recovery. These are controlled lifecycle tests, not a model-quality benchmark.

## Local scan measurement

A synthetic disk-store probe used 10, 100 and 500 active records with roughly
1,060 characters per body, a unique body-only query and `limit: 1`. Seven
searches at each size all returned exactly one match. Instrumenting the store's
content-read method counted one body read per candidate on every search:

| Active records | Content reads per query | Observed median ms |
| --- | --- | --- |
| 10 | 10 | 11.4 |
| 100 | 100 | 37.2 |
| 500 | 500 | 131.0 |

These timings are descriptive only: local filesystem cache and a concurrently
running test suite were not controlled. They are not a before/after speedup or
p95 estimate. The repeatable finding is the read count despite a result limit
of one. Raw local artifacts are `/tmp/namzu-memory-scan-bench.mjs` and
`/tmp/namzu-memory-scan-results.json`; they are temporary investigation files,
not installed SDK artifacts.

## Upstream code

[Pydantic Harness FileStore search](https://github.com/pydantic/pydantic-ai-harness/blob/8e863b5b88c9e41e638f0dc416b8946135b584b7/pydantic_ai_harness/memory/_store.py#L795)
accepts separate `limit`, `max_files`, `max_chars` and `max_file_chars` bounds.
Its result includes `scanned` and `truncated`; the implementation probes one
extra path and one extra character to report incomplete scans. This is a useful
contract to study, not evidence of indexed constant-time retrieval. Its hidden
SQLite journal also must not be confused with a full-text retrieval index.

Namzu's next storage experiment should expose scan/byte bounds and completeness
without silently turning partial search into an authoritative `totalCount`.
Alternatively, an inverted index could preserve full-search semantics, but it
must account for edits, archives, deletion, concurrent writers and crash recovery.
Changing a data structure without those guarantees would regress current memory
correctness. No disk format or ranking policy changes in this patch.

## Paper screening

| Primary source | Relevant idea | Applicability boundary |
| --- | --- | --- |
| [AgentIR, 2605.25092](https://arxiv.org/abs/2605.25092v1) | Gate expensive dense retrieval using a cheap lexical signal. | Namzu has neither this BM25 score nor a dense channel to gate. First collect retrieval scores and workload-specific quality/cost measurements. |
| [Harness the Memory, 2608.15008](https://arxiv.org/abs/2608.15008v1) | Substrate quality depends on task regime; excessive retrieval can hurt sequential decisions. | Evaluate both factual recovery and action selection. More recalled text is not automatically better. |
| [MemHarness, 2607.28272](https://arxiv.org/abs/2607.28272v1) | Reconstruct retrieved experience for the current state. | Its policy learns through GRPO on ALFWorld/WebShop. A generic rewrite prompt does not reproduce that training or establish the reported benefit. |
| [AgenticRag-R1, 2608.29622](https://arxiv.org/abs/2608.29622v1) | Memory stack, finer actions and action-aware rewards. | This is an RL framework. Its [published repository](https://github.com/jiangxinke/Harness-RL/tree/AgenticRAG-R1-Whitebox) documents a VeRL/GPU training setup, not a drop-in TypeScript runtime feature. |

The last two are screened from their abstracts and repository documentation;
no trained policy was reproduced. Their reported scores are not Namzu results.

## Ordered experiments

1. Measure disk reads, bytes scanned, lock wait and p50/p95 latency at increasing
   corpus sizes, while preserving exact ranking results. Separate output budget
   from execution cost.
2. Compare bounded partial search and an incrementally maintained index against
   full search on held-out queries, including body-only facts and corrections.
   Report misses and incomplete scans, not just latency.
3. Evaluate selective recall on matched memory-on/off runs with a cheap model.
   Include unrelated memories, conflicting old facts and current operator
   steering. Track task success, calls, tokens and recall relevance separately.
4. Only then calibrate routing or adaptive reconstruction. Use held-out
   confirmation runs through [paired harness verification](harness-verification.md)
   before treating a tuned configuration as a default improvement.
