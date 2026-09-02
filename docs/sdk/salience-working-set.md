---
type: Plan
title: The salience-scored working set
description: The work plan that turns "every message is scored and the context changes dynamically" from a promise into the kernel's context-management algorithm, phase by phase, with what each phase must prove.
tags: [sdk, cli, compaction, memory, plan]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# The salience-scored working set

## What is promised, and what exists

The product promise reads: compaction does not depend on an LLM; every message is scored by relevance, repetition and its inputs and outputs; the context changes dynamically on those scores; the work done is kept and a task continues without losing its thread; long tasks cost less; a 1M window lives longer.

What the kernel does today (`packages/sdk/src/compaction/`):

| Promise | Today |
| --- | --- |
| Not LLM-dependent | The first line of defence is arithmetic: stale tool-result bodies over 1,000 chars, beyond the last 3, are cleared (`tool-result-editing.ts`). The structured state (task, plan, files, decisions, failures, discoveries, requirements, notes) is extracted by rules (`extractor.ts`). When a summary is built, an LLM **verifies** it by default (`llmVerification: true`, one call, ≤ 2,048 output tokens). |
| Every message scored | No per-message score exists. Selection is positional and structural: the leading system floor, `retain` markers, the last `keepRecentMessages` turns, the last `keepRecentToolResults` results, and a cut that never splits a `tool_use`/`tool_result` pair (`retention.ts`, `dangling.ts`, `plan.ts`). |
| Relevance, repetition, inputs/outputs | Repetition is observed only by the repeat-call tracker, which advises the model; it plays no part in what the context keeps. Relevance is not measured. |
| Dynamic context | One trigger at `triggerThreshold` (0.7 of the window) with hysteresis to `resetThreshold` (0.4). Below 0.7 nothing changes. On a 1M-window model the first change happens at ~700k. |
| Keeps the work done | The structured state and the `retain` marker do this well; measured on a 20k-window run, two clearing passes reclaimed ~2.4k tokens and the task finished correctly. |

The gap is the scoring and the dynamism. This plan closes it without a model in the loop.

## Terms of art

- **Working set** — the messages the model is shown on the next call. Borrowed from virtual memory: the pages a process needs now, kept resident; everything else is evictable.
- **Salience** — a per-message score of how much the next step depends on it. Cognitive-science usage: what draws attention in a field of stimuli. Here it is the sum of recency, relevance, utility and non-redundancy.
- **Recency decay** — salience falls with turn distance, exponentially with a half-life measured in turns, not wall-clock time.
- **Relevance** — lexical similarity between a message and the *goal vector*: the task statement, the user's requirements, the open task-list items and the latest assistant intent. BM25 over an identifier-aware tokenizer (path segments, `camelCase`, `snake_case`), no embeddings.
- **Utility** — evidence a message was *used*: a tool result whose paths or identifiers reappear in a later tool input or assistant turn; an assistant turn followed by the tool calls it announced. Citation, not content.
- **Redundancy** — near-duplicate detection with word-shingle MinHash (Jaccard estimate); the older of two near-duplicates is demoted, the newer kept. Identical tool calls (the repeat tracker's key) demote their older results.
- **Eviction policy** — the tiered actions taken on low-salience messages, from cheapest to most lossy: clear a tool-result body, stub an assistant narration to one line, fold a span into the structured state, and only under overflow summarize with LLM verification.
- **Hysteresis** — a pass must bring the context below a reset level, or it is not repeated on the next iteration.
- **Memory tiers** — *working memory* (the working set, one run), *episodic memory* (the structured state and compaction summaries: what happened in this run), *semantic memory* (durable learnings across sessions: the memory store behind `save_memory` / `search_memory`). What the owner calls "öğrenimler" is semantic memory, promoted from episodic memory by **consolidation**: a discovery or decision that survives a run, or recurs across runs, is written down; a summary is not a learning until it is consolidated.

## The algorithm

For every non-floor message *m* at iteration *t*:

```
salience(m, t) = w_rec · exp(-(t - t_m) / τ)
              + w_rel · bm25(m, goal(t))
              + w_use · utility(m, t)
              - w_red · redundancy(m, t)
```

with structural overrides that no score may cross: the leading system run and the working-memory slot always stay; `retain` markers always stay (and pull their pair and turn boundary in); the last `keepRecentMessages` turns always stay; a `tool_use` and its `tool_result` share a fate.

The working set is chosen by budget: sort evictable messages by salience per token, evict from the bottom until the estimated context is under the **soft target** (default 0.5 of the window), applying the cheapest tier that reclaims enough. The **hard trigger** (0.7) and the overflow path stay as they are, as the floor under the new behaviour. Scores are cached per message and only the recency term is recomputed each iteration, so the pass is O(n) in messages with n small.

Everything above is deterministic and runs without a model call. The LLM verification of a summary remains available on the overflow path and stays configurable; the default for the salience strategy is off, so "not LLM-dependent" is true by default and a host that wants the check turns it on.

## Phases

Each phase lands as its own change with its tests and a changeset. Nothing changes the default behaviour until Phase 6. Phases 1–5 have landed as `strategy: 'salience'`, opt-in, with the CLI's `compaction` key and `/context`. Of Phase 6, the eval suite (`packages/evals/kernel/salience.eval.js`) has landed and passes: the cited fact survives where the structured strategy loses it, and the final history is no larger. Two rules the eval forced: evictions are ordered by salience with the larger message first among equals (per token evicted the one large result the goal named), and a message the goal names or a later turn cited is not evicted to reach the target while it scores above half the most salient evictable message. The default is now `salience` in the kernel and the CLI; `structured` is one word away. Consolidation (episodic → semantic) remains.

### Phase 1 — Scoring core (`compaction/salience/`)

- `tokenize.ts`: identifier-aware tokenizer (paths, `camelCase`, `snake_case`, dotted attribute keys), stop-word list, no stemming.
- `bm25.ts`: BM25 over the run's messages as the corpus, incremental document frequency.
- `minhash.ts`: 3-word shingles, 64 hashes, Jaccard estimate; `nearDuplicate(a, b, threshold = 0.8)`.
- `score.ts`: `scoreMessages(messages, goal, iteration, weights)` returning `{ id, tokens, recency, relevance, utility, redundancy, salience, protected: reason | null }[]`. Pure; no run, no logger, no provider — the same discipline `plan.ts` keeps and greps for.
- Proof: unit tests on hand-built histories — a fact stated in turn 2 and cited in turn 30 outscores chatter from turn 28; the second of two identical reads is kept and the first demoted; a `retain` message is protected whatever its score; identifier tokenization finds `src/store.mjs` from `store`.

### Phase 2 — Goal vector and utility signals

- `goal.ts`: the goal vector from the first user message, later user turns (requirements), open task-list items (from the task store when a run has one) and the latest assistant text.
- Utility: a citation index built once per iteration — paths and identifiers in tool inputs and assistant turns, looked up against each tool result's paths and identifiers.
- Proof: a tool result whose file the model later edits scores as used; one the model never referred to scores as unused; the goal vector changes when a new requirement arrives and relevance follows it.

### Phase 3 — Eviction tiers and the working-set plan

- `working-set.ts`: `planWorkingSet(scored, budget, config)` returns the actions: `clear` (tool-result body), `stub` (assistant narration to its first sentence plus "… elided"), `fold` (a span into the structured state via the existing extractor), `keep`. Respects pairs and turn boundaries via `findSafeTrimIndex` and `findRetainedIndices`.
- `compaction.strategy: 'salience'` selects it in `plan.ts`; `structured` and `sliding-window` are untouched.
- Proof: pair integrity under every plan (a property test over random histories, asserting no split pair and no leading assistant turn); the plan reaches the soft target when it can and says by how much it fell short when it cannot.

### Phase 4 — Dynamic application and hysteresis

- The compaction phase runs the salience pass every iteration once the estimate exceeds `softTarget` (default 0.5), not only at `triggerThreshold`; a pass that cannot bring the context under `softReset` (default 0.35) is not repeated until the estimate has moved.
- Prompt-cache awareness: the pass prefers actions that leave the cached prefix intact (evict from the newest evictable region first when two candidates tie), because a cleared body in the middle of the prefix invalidates every cached token after it.
- Proof: a long synthetic run under a 20k window shows context oscillating between the targets rather than climbing to 0.7; the number of provider-cache-busting edits per iteration is bounded.

### Phase 5 — Observability in the kernel and the CLI

- Event `context_scored` per pass: the top kept and evicted messages with their component scores, tokens reclaimed, and the tier used. Logged under `namzu.context.*` attributes.
- CLI: `/context` shows the working set — what is held, what was cleared or stubbed and why, and the current fraction of the window. `/cost` gains the shed total. The transcript row for a pass reads "kept N · cleared K (~T tokens) · stubbed S".
- Proof: the existing screen-harness tests, plus one that drives a pass and asserts the row.

### Phase 6 — Evaluation, defaults and the promise

- `packages/evals`: a long-run suite with 40–80 turn fixtures carrying needle facts in early turns. Metrics: input tokens per task, needle recall at the end, task success, provider rejections (must be zero), passes per run. Reported for `structured` and `salience` side by side; `salience` must not lose recall and must cut input tokens.
- Flip the default to `salience` behind a major bump, with `structured` selectable. Rewrite the product text to what is now true: scored per message by recency, relevance, use and repetition; deterministic; dynamic from half the window; verified summaries optional.
- Consolidation: a `memory_consolidated` event and a rule in the compaction summary path that offers discoveries and decisions to the semantic memory store when a run ends — the bridge from episodic to "öğrenimler". Opt-in for the host.

## What is deliberately not in this plan

- Embeddings. They are a model dependency by another name and the promise says none; BM25 with an identifier-aware tokenizer is what the code can keep honest.
- Token-level pruning (LLMLingua-style). It rewrites what the model reads; this plan removes or stubs whole messages so every kept message is verbatim.
- Attention-based KV eviction (H2O, StreamingLLM). Those live inside a serving stack the kernel does not own.
