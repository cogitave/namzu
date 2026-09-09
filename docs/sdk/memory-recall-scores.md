---
type: Explanation
title: Measured automatic memory recall
description: A paired live Luna low evaluation of recall correctness, strict answer format and consumption.
resource: scripts/benchmarks/memory-recall.mjs
tags: [sdk, cli, memory, evals]
---

# Measured automatic memory recall

On 2026-09-09, the built production CLI at `086ade90` ran 24 live provider
rollouts: six synthetic scenarios, two distinct data variants each, with
`memory.recall` off and on. Both arms used Codex `gpt-5.6-luna`, effort `low`,
six maximum model iterations and a 30,000-token run budget. Explicit memory
tools remained available in both arms. No mock provider or LLM judge was used.

This compares an existing feature on/off on the same revision. It does not
measure the preceding timeout-admission patch, which requires a stalled store
to exercise, and is not an ARC or general coding benchmark.

## Results

| Metric, twelve runs per arm | Automatic recall off | Automatic recall on |
| --- | --- | --- |
| Factually correct, manually reviewed | 12/12 | 12/12 |
| Predeclared strict answer format | 8/12 | 12/12 |
| Aggregate reported tokens | 175,777 | 107,587 |
| Tool calls | 21 | 8 |
| Sum of subprocess wall times | 93.6 s | 65.9 s |
| Failed/incomplete provider runs | 0 | 0 |

Tokens fell by 38.8% and tool calls by 61.9% in this small suite. The observed
wall-time reduction was 29.6%; provider/network variability, prompt caching and
process startup were not controlled, so it is not a kernel-latency improvement
claim. Pricing was unavailable for all reported tokens; `totalCost: 0` in raw
records does **not** establish that the calls were free.

The strict scorer was fixed before running: trim, lowercase, remove one final
period, then compare exactly with the expected value. Four baseline responses
were `17 hours`, `18 hours`, `28 hours`, and `29 hours`, rather than just the
number. Their strict failures remain in the data. Post-hoc manual review accepts
those four as factually correct; no other results were overridden. A 33-point
knowledge-accuracy improvement would therefore be a misleading interpretation.

| Scenario, two variants | Factual off/on | Tokens off/on | Tools off/on |
| --- | --- | --- | --- |
| Find a body-only historical fact | 2/2 and 2/2 | 32,018 / 16,219 | 4 / 1 |
| Read the corrected value, not the old body | 2/2 and 2/2 | 32,009 / 10,741 | 4 / 0 |
| Reject an archived fact as current evidence | 2/2 and 2/2 | 21,130 / 21,146 | 2 / 2 |
| Follow the user's new value over old memory | 2/2 and 2/2 | 32,094 / 10,791 | 4 / 0 |
| Follow the current file over old memory | 2/2 and 2/2 | 26,484 / 27,034 | 3 / 3 |
| Answer UNKNOWN when memory is unrelated | 2/2 and 2/2 | 32,042 / 21,656 | 4 / 2 |

The file scenario used slightly **more** tokens with recall. The lexical
selector also surfaced irrelevant memory in the unrelated scenario because of
shared vocabulary such as `seconds`. The model still returned UNKNOWN. Correct
answers do not prove that recall selection was relevant or efficient in every
case; these are candidates for a harder selective-recall evaluation.

## Controls and evidence

All questions, expected values and memory mutations were written into the
manifest before the first model call. Every arm started a fresh stateless CLI
run. The runner reset only its newly created synthetic project's memory before
each run, restored the same fixture, and changed only the recall flag. One
variant ran off/on, the other on/off. There was no model retry or prompt tuning
after observing scores. The second variant changed identifiers and values;
there was no provider seed control.

Production transcripts were matched to all 24 rows in execution order, with
exact final-answer and token-total checks. Recorded request envelopes confirmed
the requested model, no injected recall in the off arm, and no archived recall
in either arm. The on arm contained recall in the other scenarios. Row-level
trajectory IDs, original answers, tools, costs, and the pre-run manifest are
retained in `scripts/benchmarks/results/2026-09-09-memory-recall.json`.
Full local stream transcripts and stderr are in
`/tmp/namzu-recall-scores-0909/`; they are not installed package artifacts.

This is six hand-authored task families with two variants, not twelve independent
benchmark families. The suite is small and easy enough to reach a factual
ceiling. It does not exercise long-context compaction, checkpoint recovery,
mid-run steering, large memory corpora or concurrent access. There is no held-out
confirmation batch or independent attribution review, so this is not grounds for
automatic candidate promotion through the harness verification gate.

## Reproduce

Build the workspace first. With an already configured Codex credential, run:

```sh
node scripts/benchmarks/memory-recall.mjs /tmp/namzu-recall-scores-new
```

The output directory must not exist. This is an explicit opt-in live benchmark
that spends provider quota; it is not loaded by the offline eval runner. It
uses a new temporary workspace and a new central project, retaining evidence
for inspection. It stops on an unhealthy run rather than silently spending more
quota; partial results remain on disk. The committed runner additionally records
the full current git revision and escalates process termination after a timeout;
neither affects the completed measurements above.

The next experiment should predeclare separate factual and formatting scorers,
add distractor-heavy and multi-step tasks, and measure retrieval relevance as
well as final success. Keep the current suite as a regression reference rather
than tuning exclusively to these six examples.


## Identifier-grounding candidate

A follow-up on the same day used the working-tree identifier-grounding candidate,
with **automatic recall enabled in both arms**. Only `identifierGrounding`
changed. The same six families used new numeric variants (100 and 101), not
held-out task families. The paired settings were explicit in all 24 runs; the
final default of false does not change those settings.

| Metric | Grounding off | Grounding on |
| --- | --- | --- |
| Factually correct, manually reviewed | 12/12 | 12/12 |
| Strict format | 12/12 | 11/12 |
| Reported tokens | 102,061 | 112,488 |
| Tool calls | 7 | 9 |
| Sum of subprocess wall times | 53.6 s | 70.1 s |

The sole format miss was `128 hours` instead of `128`. In the two unrelated
cases, automatic irrelevant-memory injection fell to zero in recorded request
envelopes. However, the model used `search_memory` **and** `read_memory` in each
candidate run, compared with search alone in each baseline run. Removing an
irrelevant automatic reminder did not remove the model's desire to investigate.
Overall token use rose 10.2%; no factual improvement was observed. This is why
identifier grounding remains **opt-in**, not a new default. The result does not
establish a causal latency penalty or general accuracy parity beyond this set.

The raw rows, trajectory IDs, stream/transcript digests and measured build-file
digests are in `scripts/benchmarks/results/2026-09-09-identifier-grounding.json`.
Raw local logs are in `/tmp/namzu-grounding-scores-0909/`. No failed provider
runs were excluded. Reproduce this ablation explicitly with:

```sh
node scripts/benchmarks/memory-recall.mjs /tmp/namzu-grounding-scores-new grounding
```

This control enforces an exact lexical requirement when the host wants it. It
is not a general solution to recall relevance: aliases and renamed entities
need separate evaluation, and direct tool search still returns broad matches.
