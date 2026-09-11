---
type: Reference
title: Cumulative tool-call admission budget
description: Per-run attempt reservations before batch, nested and retry execution, with durable recovery accounting.
resource: packages/sdk/src/runtime/query/tool-call-budget.ts
tags: [sdk, tools, limits, recovery]
status: stable
---

# Cumulative tool-call admission budget

`query({ maxToolCalls, ... })` limits cumulative tool execution admissions for one
run. The value is a nonnegative safe integer. Zero refuses all new calls;
omitting the option preserves unlimited behavior. This is independent of model
iterations, concurrent-call limits, token budgets and tool deadlines.

Before executing a model's batch, the executor reserves its entire pending call
count. If three calls arrive with two slots remaining, all three receive error
results and none executes. Completed outcomes supplied by crash recovery are
returned unchanged and excluded from the new reservation. Existing authorization
denials retain their own reasons. Budget refusal consumes no new slots and does
not ask for approval or imply approval could override the budget.

Each admitted nested dispatch, including `run_code` host calls, reserves one
additional slot. Each in-loop retry also reserves one slot before its next
execution. Concurrent nested calls serialize admission accounting, while admitted
execution retains normal concurrency. Dynamic nested calls are admitted when
dispatched: unlike a direct model batch, the executor cannot preflight an unknown
future program. The parent itself also consumes a slot.

Reservations are conservative and never refunded. Denied or invalid calls in an
admitted batch, failures, cancellations, timeouts and calls abandoned before
their bodies start retain their slots. This bounds admissions rather than
claiming every reservation produced an external side effect. Provider requests,
argument repair, review hooks and background work after its launch are separate
resources; a launched background job consumes its tool call, not a slot per
process action. Delegated runs have independent budgets; this is not a shared
agent-tree allowance.

## Durable accounting and recovery

With the option configured, `query` restores usage from its strict run event log
and persists a `tool_calls_admitted` reservation before releasing execution.
The event carries `kind` (`initialize`, `batch`, `nested`, or `retry`), `count`,
cumulative `used`, and the configured `limit`. Initialization has count zero.
The SSE and A2A bridges omit these internal ledger events.

The runtime reads the ledger through the same queue that writes durable events.
It waits for earlier writes and holds later writes until the read settles, so
an in-flight append cannot look like a torn transcript. This ordering does not
relax integrity checks: an incomplete record left by a settled write still
prevents admission.

Compacting message history does not erase the ledger. Resume the same native run
with `maxToolCalls` supplied again: the host owns the policy, and this option is
not inherited from a checkpoint when omitted. Changing the configured limit
changes the allowed total but does not reset recorded usage.

Completed recovery results are not charged again. Unfinished calls retried after
a crash are new admissions, while their previous reservations remain spent.
Recovery may therefore refuse an unfinished call even when its earlier body
never started. This deliberate overcount avoids inventing refunds for uncertain
execution. Starting a new run starts a new budget.

Unreadable, foreign, discontinuous or malformed ledger evidence fails closed
before tool execution. So does enabling a budget on an older run whose existing
tool execution predates an admission ledger: its attempt count cannot be
established honestly. Recovery rejects more than 100,000 returned events; the
injected RunStore still owns the I/O and allocation cost of reading that log.
A failed admission write prevents execution and invalidates further admissions
on that executor. A cancelled call cannot enter a tool body after its reservation.
Stores must settle their persistence operations; this option does not add a
separate persistence timeout.

This uses the run's existing ownership/fencing and durability guarantees. It is
not a distributed compare-and-swap counter for independently active executors.
An internal `ToolExecutor` without a replay reader has only instance-local
accounting; the public query path supplies the run-store reader automatically.
