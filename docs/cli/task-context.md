---
type: Reference
title: Current-run task context
description: Bounded automatic projection of unfinished tasks into interactive model requests, with research rationale and verification limits.
resource: packages/cli/src/integrations/sessions/task-context.ts
tags: [cli, tasks, context, harness]
---

# Current-run task context

Interactive sends and checkpoint resumes read the same task store used by
`task_create`, `task_update` and `task_list` before each model request. They
append a small snapshot of unfinished tasks to the prepared system context,
without writing reminder messages into conversation history or making another
model call. This lets a run retain its explicit plan when earlier task-tool
results are no longer in the visible history.

The snapshot is agent-maintained planning data, not proof that work passed
verification. Current user directions take precedence. A stale description
still needs updating through the task tools; this feature cannot infer that a
new instruction invalidates the old plan.

Only records matching both the invoking run and tenant are eligible. A new
run does not inherit previous runs' tasks. Resuming the same run can recover
its durable tasks. This is distinct from cross-run project memory.

The projection prioritizes in-progress tasks, then failed tasks, then pending
tasks, with stable creation-time/ID ordering within each class. Completed tasks
are omitted; dependencies whose records are missing or not completed count as
unresolved. At most eight rows include a task ID, status, clipped subject and
description, and unresolved dependency count. An omitted count makes the
partial view explicit. Use `task_list` for the full plan.

The added block is at most 2,400 UTF-16 code units, further limited to the
integer remaining-token estimate treated conservatively as a character
allowance. This is not an exact tokenizer measurement. Below 700 estimated
remaining tokens the projection is skipped. Empty and completed plans add
nothing. Existing prepared system context is preserved.

Each store read gets 250 ms of caller waiting time. A failed or timed-out
prepare step follows the kernel's existing diagnostic/fail-open handling.
Cancellation propagates. Because TaskStore has no cancellable list operation,
the underlying read may continue; the hook prevents overlapping reads and
never injects the late result as a cached plan. This bounds waiting and prompt
size, not the disk store's total scan work. Large task histories still need an
indexed or paginated store.

# Research and implementation boundary

[Pydantic Harness planning](https://github.com/pydantic/pydantic-ai-harness/blob/8e863b5b88c9e41e638f0dc416b8946135b584b7/pydantic_ai_harness/planning/_capability.py#L170)
reads the current plan and appends an ephemeral tail reminder to model requests.
This motivated Namzu's automatic projection. Namzu uses its existing prepare
step and host-owned task store; it does not reproduce Pydantic's cache breakpoint
or tail-message transport.

[Proactive Memory Agent](https://arxiv.org/abs/2607.08716v1) studies a separate
memory agent that selects when to remind the action agent. Its selective
intervention results motivate measuring relevance instead of assuming more
memory is better. The deterministic snapshot here is not that algorithm and
inherits none of its reported benchmark gains.

[AgentIR](https://arxiv.org/abs/2605.25092v1) routes retrieval using BM25 score
margins to avoid unnecessary dense retrieval. This remains a candidate:
Namzu needs score telemetry, calibration workloads and paired quality/cost
measurements before adopting a threshold. No learned router or new embedding
call is added here.

[Deep Agents memory middleware](https://github.com/langchain-ai/deepagents/blob/fc91199a44b99990cca49341169aea858da222fc/libs/deepagents/deepagents/middleware/memory.py)
injects memory from state into the system request. Its
[summarization middleware](https://github.com/langchain-ai/deepagents/blob/fc91199a44b99990cca49341169aea858da222fc/libs/deepagents/deepagents/middleware/summarization.py)
also handles offloaded history and inline media. Full binary-evidence recovery
remains separate from Namzu's [retained-text reader](conversation-evidence.md).

Next research priorities are retrieval calibration, indexed task reads, and
artifact acceptance/targeted repair evaluated with held-out paired trials.
A passing store/protocol regression is not evidence of a long-horizon score gain.

# Verification

Regression tests cover cross-run/tenant exclusion, fresh updates with empty
history, completed/failed dependencies, ordering and omission, prompt limits,
read timeout/backpressure and cancellation. A production session adapter test
executes `task_create` through the SDK and inspects the next provider request,
then verifies that a new run has no inherited snapshot.

A real interactive `gpt-5.6-luna` / `low` smoke run on 2026-09-09
(`1feda1b7-4768-4c70-807b-e4bcb718c3b1`) created two dependent tasks, marked the
first in progress, read a synthetic artifact and completed the first task.
Five tools succeeded across six model requests (41,757 aggregate input/output
tokens). Recorded request envelopes showed dependency count 1 before completion
and 0 afterward; the final answer reported that count and the exact artifact
text without calling `task_list`. This checks the live adapter and state
transition, not long-horizon success, compaction recovery, steering or a speedup.
The empty-history regression isolates projection recovery; automatic compaction
and checkpoint resume still need a dedicated live scenario for this feature.
