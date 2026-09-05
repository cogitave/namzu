---
type: Reference
title: Harness invariants
description: Ownership, budget conservation, result recovery and evidence from bounded live runs.
resource: packages/sdk/src/runtime/query/iteration/index.ts
tags: [sdk, runtime, budgets, engineering]
status: stable
---

# Harness invariants

A successful model reply depends on the surrounding runtime preserving the
right evidence, ownership and resource boundaries. A benchmark result alone
does not identify which boundary failed. The following contracts are exercised
by regression tests and a bounded live CLI smoke check.

| Boundary | Enforced behavior |
| --- | --- |
| Identity | Entity IDs are UUIDs; tenant and Project membership come from authoritative records, not an ID prefix. One checkout resolves to one Project root binding. |
| Context | Triggering, retention and token relief use the same multimodal estimate. Encoded bytes remain storage measurements. |
| Tool evidence | Text overflow retains a bounded preview. Rich blocks have an independent budget. Recovery reads retained evidence rather than replaying a state-changing action. |
| Artifact paths | Provider correlation IDs never become path components. Spill filenames use a digest and exclusive creation. |
| Delegation | A child's effective token cap cannot exceed its reserved allocation. Failed startup returns the reservation and disposes owned resources. |
| Completion | Exhausted hard guards do not buy an extra model summary. Streaming completion is emitted once, after the persistence attempt. |

The host-readable output and model-readable content can differ. Each text
channel receives its own bounded preview. Model-content spills use the
`tool-output/content/<digest>.txt` directory, separate from the host-output
artifact. Withholding rich blocks preserves bounded text and its recovery path
when the configured text cap can contain it.

## Delegation accounting

Let the parent's remaining tokens be `R` and a child's allocation be `A`.
Admission reserves atomically, leaving `R - A`. A positive smaller builder cap
may narrow that allocation; a larger or unlimited (`0`) builder value is clamped
to `A`. Negative or nonfinite values are refused. Shared builder results are
copied before parent authority and limits are applied.

If startup fails before the child executes, rollback returns exactly `A`, removes
the pending task and child-session bookkeeping and disposes the owned workspace.
It does not assign an old snapshot of `R`, which would erase concurrent changes.
A started child follows normal usage settlement. This is reservation accounting,
not a guarantee that a provider cannot report more usage than the final in-flight
request's remaining allowance.

The regression suite is
`packages/sdk/src/manager/agent/__tests__/budget-startup.test.ts`.
Hard-stop request counts are covered by
`packages/sdk/src/runtime/query/__tests__/hard-stop-does-not-spend.test.ts`.

## Remaining aggregate-budget boundary

A child reservation is enforced within the manager's task pool. The pool is
separate from the parent query's own usage counter: this release does not yet
provide a single conserved token wallet for an entire delegation tree.
`SupervisorAgent` constructs both its delegation pool and its query from the
configured budget, and returns the parent query's usage. Charging child totals
only after completion would not protect concurrent work or durable resume.

The CLI's initial task pool now follows the configured run token budget instead
of an unconditional one million tokens. This removes an allocation mismatch;
it does not make the separate pools aggregate accounting. The next architectural
step is one shared reservation ledger, charging measured requests once across
all descendants and restoring unsettled reservations on resume. Token and cost
reports must distinguish parent usage from subtree usage until that exists.

## Bounded live evidence

On 2026-09-06, an isolated CLI workspace used `gpt-5.6-luna` with explicit `low`
effort. An observer checked the actual outgoing request's model and effort and
refused a different model or more than six requests. No provider fallback was
configured. This check used the installed subscription credential without
copying credential contents into its report.

The task ran a failing JavaScript assertion, corrected an inclusive loop bound
and reran the same unchanged test. It completed in six model requests, seven
tool calls and 31,027 reported tokens. The first failure was `0 !== 1`; after
changing `< n` to `<= n`, the check printed `range checks passed`.

A second process reopened the same named conversation from a checkout
subdirectory. In one request and 5,632 tokens, it recalled the exact failure,
change and passing output without another tool call. The application home
contained one Project and one Session. The corrected stream emitted one terminal
event. Both runs used local sandboxed execution. The provider usage was reported
as unpriced, so a monetary total cannot be inferred from the zero cost field.

This establishes the tested file-edit, error-recovery, conversation and root
binding paths. It does not establish long-horizon reliability or a benchmark
score. In particular, visual salience remains a conservative heuristic; tool
schemas and standing instructions still cost tokens on a small task. Future
comparisons need matched model, effort, task, tool interface and measured usage,
with repeated trials before attributing a score difference to the harness.
