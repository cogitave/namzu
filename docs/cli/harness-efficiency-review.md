---
type: Analysis
title: Harness efficiency review
description: Revision-pinned harness comparisons, existing strengths, targeted repairs and acceptance measurements.
resource: packages/cli/src/tui/agent.ts
tags: [cli, sdk, tools, performance, evaluation]
status: draft
---

# Harness efficiency review

Reviewed on 2026-09-08 against Namzu baseline
`400cf27b5c5e31f51dc686fc6805e6629f8f76fa`. The comparisons below use
upstream revisions resolved that day:

| Project | Revision |
| --- | --- |
| Codex | [`d6489472f3c15e87d2d7763a5fde033545c530f8`](https://github.com/openai/codex/commit/d6489472f3c15e87d2d7763a5fde033545c530f8) |
| OpenCode | [`d6855b6b47a8433462ac6aeeba882ccf734cb7f1`](https://github.com/anomalyco/opencode/commit/d6855b6b47a8433462ac6aeeba882ccf734cb7f1) |
| Pydantic AI | [`716f2ae4a1cb2650ce4ee58f702d1f60c3c93f8c`](https://github.com/pydantic/pydantic-ai/commit/716f2ae4a1cb2650ce4ee58f702d1f60c3c93f8c) |
| Pydantic AI Harness | [`c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504`](https://github.com/pydantic/pydantic-ai-harness/commit/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504) |

Source inspection establishes behavior and integration gaps. An in-memory
scheduling probe establishes one ordering difference described below. No cross-harness
live provider comparison was run for this review; it establishes no ranking of task
quality, latency or cost. Earlier audits remain scoped to their own revisions.

## Repairs implemented and verified

Codex's [model picker](https://github.com/openai/codex/blob/d6489472f3c15e87d2d7763a5fde033545c530f8/codex-rs/tui/src/chatwidget/model_popups.rs#L298)
dispatches setting updates directly; OpenCode's
[picker](https://github.com/anomalyco/opencode/blob/d6855b6b47a8433462ac6aeeba882ccf734cb7f1/packages/tui/src/component/dialog-model.tsx#L142)
sets the selected model directly. Namzu already has an operator `/model` path.
Its conversational `switch_model` adds another entry point, but at baseline a
successful receipt asked the model to finish before the host could apply it.
Successful repeated calls received advice rather than a runtime stop.

`packages/cli/src/tui/model-switch-tool.ts` now uses the SDK's existing
`terminal: true` contract, directs the model to call it alone, and returns a
short pending receipt. `packages/cli/src/tui/App.tsx` reuses an already accepted
request; `packages/cli/src/tui/model-switch.ts` ranks relevant choices before
the eight-choice limit. Host confirmation still follows successful application.
Only a sole successful terminal call ends the run; rejected requests and mixed
batches retain the normal loop. This preserves other requested tool results.

Discovery also needs to reflect the actual roster. At baseline,
`packages/cli/src/tui/agent.ts` mounted `search_tools` even when nothing needed
loading. This patch removes that unconditional registration and relies on the
SDK query's existing conditional registration when deferred tools exist. Codex
[searches deferred metadata and returns an empty result for no match](https://github.com/openai/codex/blob/d6489472f3c15e87d2d7763a5fde033545c530f8/codex-rs/core/src/tools/handlers/tool_search.rs#L205).

Acceptance: one accepted sole switch, one inference, one applied confirmation;
no discovery tool in a roster without deferred tools. Rejection, cancellation,
replacement failure, history retention and mixed-batch receipts remain covered.
Real-query regression tests demonstrate one inference for an accepted switch,
including a fixture that would otherwise repeat it; a rejected request followed
by correction takes two. Plugin discovery still reaches deferred tools through
the real query loop. The full CLI suite passed with 2,364 tests and two skips.

A live terminal smoke check used free Zen Muse at low effort and the request
“gpt-5.6 lunaya geçer misin” alongside a reference code: one inference, one switch
call, no tool search. A subsequent Codex Luna turn at low effort recalled the
code exactly. Durable records confirmed the source model and preserved history;
saved defaults were unchanged. This is one live sample, not a performance ranking
or a claim that publishing gates have run.

## Existing capabilities to preserve

* Memory already spans curated files and durable project records. Bounded recall
  adds relevant records without another model call; edits and archival affect
  later recall. See [Memory](memory.md) and
  `packages/cli/src/memory/provider-boundary.test.ts`. This is retrieval of
  historical claims, not automatic verification or access to every old message.
* Durability already includes completed-call recovery, checkpoints and a
  separately persisted tree budget: `packages/sdk/src/runtime/query/resume-pending.ts`,
  `packages/sdk/src/runtime/query/checkpoint.ts` and
  `packages/sdk/src/store/run/token-budget-disk.ts`. Recovery does not guarantee
  exactly-once effects in an external service. See [Harness invariants](../sdk/harness-invariants.md).
* `packages/cli/src/tui/permission-review.ts` presents complete readable inputs
  and falls back to exact input when a known formatter encounters a new shape.
  Delegation review includes the full prompt and role. OpenCode's sampled
  [task approval metadata](https://github.com/anomalyco/opencode/blob/d6855b6b47a8433462ac6aeeba882ccf734cb7f1/packages/opencode/src/tool/task.ts#L119)
  contains description and subagent type. Namzu's input visibility is an existing
  strength; future summaries must retain every executable field.
* Terminal settlement, local bounded retries, structured code-mode results and
  evaluation records already exist in `packages/sdk/src/runtime/query/iteration/index.ts`,
  `packages/sdk/src/runtime/query/executor.ts`, `packages/sdk/src/tools/builtins/run-code.ts`
  and `packages/sdk/src/eval/from-run.ts`. Reuse these before adding parallel mechanisms.

## Prioritized next work

The subsequent implementation adds [bounded retained evidence search](conversation-evidence.md),
[opt-in SDK execution barriers](../sdk/tool-execution.md),
[background delegation and queued corrections](delegated-work.md), and searchable
model selection. Standalone model requests now use the host with composer previews.
The comparison rows below record the original findings and acceptance criteria;
they are not a list of wholly absent features in the updated code. Remaining
extensions include full oversized-artifact recovery, restarting completed child
tasks with their prior context, and paired model-quality benchmarks.

On 2026-09-08, a real PTY session against the built CLI accepted
`modeli opus-5 yapar mısın`, selected Anthropic Opus, then accepted
`/model gpt-6-astra` and `/effort ultra` through Codex. Model and effort previews
appeared before submission, saved defaults stayed unchanged, and no inference
run was created. This verifies host controls, not an inference benchmark for
either model. Deterministic kernel tests separately verify compacted evidence
recovery after reopening, conversation ownership, ordered writes, background
parent progress, single correction delivery and parent cancellation.

First finish discovery feedback: `packages/sdk/src/tools/builtins/search-tools.ts`
still claims that every unmatched query refers to already active tools. Distinguish
an active match, naming the callable tool, from an unknown query; preserve tool
allowlists in both branches. This SDK correction is outside the current patch.

| Priority | Confirmed behavior and proposed change | Acceptance measurement |
| --- | --- | --- |
| 1 | **Recover original evidence.** Pydantic Harness [ConversationSearch](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_capability.py#L35) searches history retained by StepPersistence; it persists nothing itself. Namzu's `packages/sdk/src/compaction/tool-result-editing.ts` preserves available spill pointers, while `packages/sdk/src/tools/memory/search.ts` searches authored records. Connect bounded, authorized conversation/artifact retrieval. | Put an exact identifier only in subsequently compacted output. Measure answer accuracy, rereads, repeated external work and tokens; also verify isolation and recovery after restart. |
| 2 | **Offer explicit execution barriers.** Pydantic's [`sequential=True`](https://github.com/pydantic/pydantic-ai/blob/716f2ae4a1cb2650ce4ee58f702d1f60c3c93f8c/pydantic_ai_slim/pydantic_ai/_tool_execution.py#L285) separates parallel segments. Namzu's `packages/sdk/src/runtime/query/executor.ts` starts concurrency-safe calls independently of the unsafe-call chain. A controlled `[write, read]` probe observed `write started`, `read saw before`, `write finished`. This is permitted by Namzu's current contract. Add a distinct barrier without silently changing that contract. | A barrier write followed by verification must expose the new value. Independent reads must still overlap. Count stale reads, corrective calls, model requests and elapsed time. |
| 3 | **Allow the parent to continue and steer delegates.** Codex separates [message delivery and follow-up turns](https://github.com/openai/codex/blob/d6489472f3c15e87d2d7763a5fde033545c530f8/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L181). OpenCode supports task reuse and [background launch behind an experimental flag](https://github.com/anomalyco/opencode/blob/d6855b6b47a8433462ac6aeeba882ccf734cb7f1/packages/opencode/src/tool/task.ts#L97). Namzu's `packages/cli/src/integrations/subagents/runtime.ts` releases a blocking wait on operator input and delivers completion later, but exposes neither proactive background launch nor a follow-up tool. | Hold a child response; parent finishes independent work without operator input. Deliver one correction and one completion; reject another run's task ID. Preserve cancellation and tree budgets. |
| 4 | **Search large model catalogues.** OpenCode's [model picker](https://github.com/anomalyco/opencode/blob/d6855b6b47a8433462ac6aeeba882ccf734cb7f1/packages/tui/src/component/dialog-model.tsx#L26) has filtering, favorites and recents. Namzu's `packages/cli/src/tui/Picker.tsx` lacks model search; searchable common menus cover other actions. | Select a model by substring from 500 entries. Keep the current marker visible at 40 columns, preserve drafts on cancellation and preserve preferences on activation failure. |

Lower-priority experiments are an ephemeral current-plan reminder, using
`packages/sdk/src/prompt/contributions.ts` as the seam, and a run-wide tool-call
allowance for workloads with expensive tools. Pydantic supplies a
[plan reminder hook](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/planning/_capability.py#L170)
and [projected batch admission](https://github.com/pydantic/pydantic-ai/blob/716f2ae4a1cb2650ce4ee58f702d1f60c3c93f8c/pydantic_ai_slim/pydantic_ai/_tool_execution.py#L495).
Measure duplicated plan steps against reminder tokens; verify tool allowances
before oversized parallel batches and across nested calls. Neither feature is
automatically an efficiency improvement.

Use the existing eval runner for paired cases with the same model, effort,
provider, token allowance, task state and tool access. Report correctness first,
then model requests, tool calls, tokens, cost and elapsed time. Deterministic
regressions verify contracts; model-backed comparisons are needed to establish
whether those contracts improve task outcomes.
