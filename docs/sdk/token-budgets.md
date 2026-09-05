---
type: Reference
title: Token budgets
description: Shared token accounting for parent runs, delegated descendants and durable recovery.
resource: packages/sdk/src/run/token-budget.ts
tags: [sdk, runtime, budgets, persistence]
status: stable
---

# Token budgets

`TokenBudget` is the token authority for a run and its descendants. `query`
opens a durable root account by default. A delegated run receives its reserved
account through `QueryParams.budget` or `BaseAgentConfig.budget`; a scheduler
exposes the same account as `TaskScheduler.budget`. `AgentTaskContext.budget`
replaces the mutable `{total, remaining}` tracker. An injected scheduler without
an account is refused instead of creating a second independent allowance.

## Accounting

A root limit of `0` means unlimited. Every child reservation is a positive,
finite safe integer. Reservations are synchronous, so two concurrent launches
cannot both claim the same available tokens. They are persisted before the
child starts. A smaller effective child cap narrows its reservation; a builder
cannot remove or widen the inherited cap.

For an account with limit `L`, measured subtree usage `U`, and open child
allowances `A_i` with subtree usage `U_i`, its unreserved allowance is:

```text
L - U - sum(max(0, A_i - U_i))
```

Only children whose execution has settled, including their descendants and
requests, release the unused portion. An overshoot remains measured usage even
when it exceeds the reserved amount. Ancestor debt constrains every branch.
Canceling a task signals it; its pending execution still owns its reservation.
An invocation that throws without returning its usage keeps its unspent grant
reserved. A failed task is not evidence that its provider spent zero tokens.

`beginRequest()` persists an outstanding request before contacting the provider.
`finishRequest(id, usage)` records the response and resolves the request together.
Usage frames within one response merge by their component high-water marks;
separate responses accumulate. Repeating a completed receipt does not charge
again. `recordUsage` reconciles an own-run cumulative counter, while
`settle(ownTotalTokens)` closes an account without charging the result twice.

`query` borrows its supplied account and does not settle it when the query
returns. The reservation owner decides whether the same run will resume from a
checkpoint. Agent managers and composite agents settle their child executions;
a host invoking `query` directly must call `settle()` once it decides that
execution is over, then await `flush()` for durable settlement. A pause or an
iteration limit alone does not refund the remaining reservation.

The SDK wraps each main-loop, advisory, compaction, router and pipeline provider
attempt. Retry and fallback consult the same admission policy before scheduling
another attempt; they cannot clear unresolved spend. Hosts composing provider
wrappers can supply `WithProviderRetryOptions.canRetry` and
`WithProviderFallbackOptions.canFallback` for additional live admission checks.
Model-requested consultations serialize within the run, sharing its allowance
and consultation quota. Custom agents and pipeline callbacks must use the
supplied account/provider and reserve a child account before invoking another agent. Calls to an unrelated
provider client cannot be intercepted by the kernel. Foreign delegation without
the metering contract is refused when a budget is bound.

## Own usage and tree usage

`Run.tokenUsage`, agent-result `usage`, and `token_usage_updated.usage` describe
the run itself. Router consumers that previously read combined usage must use
`budget.treeTokens`; the delegated result retains the child's usage and cost.
`Run.budget`, agent-result `budget`, and usage-event `budget` carry the aggregate
snapshot:

| Field | Meaning |
| --- | --- |
| `limit` | This account's cap; `0` is unlimited. |
| `ownTokens` | Tokens attributed to this run's requests. |
| `treeTokens` | Own usage plus every descendant's measured usage. |
| `reservedTokens` | Unspent allowance held by unfinished child subtrees. |
| `remainingTokens` | Available admission allowance; `null` is unlimited. |
| `inFlightRequests` | Requests whose final receipts are still outstanding. |
| `unsettledChildren` | Direct child subtrees that still hold execution authority. |
| `poisoned` | Unresolved provider spend or a failed durable write blocks admission. |

These are snapshots, not incremental charges. `treeTokens` already includes
`ownTokens`. An ancestor summary already includes its descendants; adding their
summaries would count the same work twice. A returned result is a snapshot at
that instant; a descendant may still be executing. Read the live account for a
later total.

## Persistence and resume

The default record is `token-budget.json` beside the root run under the root
session's `runs` directory. It contains the full tenant, project, session and run
scope, accounts, measured usage and request receipts. Child sessions share that
record rather than creating new roots. `TokenBudgetStore` permits another
backend; `openTokenBudget` validates scope and cap when opening an existing root.
A host restoring in another directory or process must supply the same
`tokenBudgetStore` as well as its `checkpointStore`, or resolve both through the
same `PathBuilder`. Moving only the message checkpoint does not move the ledger.

Checkpoint schema 2 and run-state version 4 carry `budgetBinding` and
`budgetAccountId`. The binding selects the canonical ledger and account; it does
not carry a replacement balance. Reading an older message checkpoint therefore
cannot undo later spending or recreate a settled reservation. Missing or
mismatched authority is refused. An account created in memory requires its live
authoritative handle when resuming; a checkpoint alone cannot reconstruct work
that continued after that checkpoint.

A cold reopen retains unfinished child reservations. It does not recreate their
workers or infer that they finished because an in-memory task registry is empty.
An outstanding provider request on cold reopen blocks admissions. Partial usage
already observed remains counted, and a broken stream cannot receive a refund
based on an absent final receipt. A typed rejection before any generation, such
as a context-size rejection or throttling, resolves with zero usage. Unknown
transport failures keep their unresolved marker. Automatic recovery does not
clear that uncertainty.

If the host later obtains the provider's final usage receipt, it can call
`await account.reconcileRequest(requestId, usage)`. This explicit operation
keeps the larger observed usage, never charges the same receipt twice, and
unblocks the ledger only after every outstanding request is resolved and all
accounting writes succeed. It does not reopen settled accounts or reset spend.
Ordinary `finishRequest` calls and automatic retries never clear this block.
Without a reliable final receipt, the request must remain unresolved.

The built-in disk store atomically replaces private files and rejects regressing
usage, grants and receipts. The store contract assumes one active writer for the
root and all its descendants. Atomic replacement is not a distributed lease;
hosts must establish exclusive root ownership before moving it to another
process. Checkpoint claims alone do not fence an independent ledger backend.

## Limits of the guarantee

Admission is based on measured tokens. An already admitted response can exceed
its remaining allowance, and multiple admitted sibling requests may finish
after a limit is reached. No further request is admitted once the observed
allowance is exhausted. Driver-internal retries are limited by the driver's
reported usage; an unreported vendor charge cannot be inferred from a transcript.

Token accounting does not establish dollar prices. `costInfo` and dollar limits
remain local to a run. When the ledger has measured usage newer than the restored
message checkpoint, the missing price attribution is reported as unpriced tokens.
