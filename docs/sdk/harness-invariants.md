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
| File discovery | Glob scope is explicit; incremental enumeration observes cancellation and both result and traversal limits. Incomplete searches remain identifiable. |

The host-readable output and model-readable content can differ. Each text
channel receives its own bounded preview. Model-content spills use the
`tool-output/content/<digest>.txt` directory, separate from the host-output
artifact. Withholding rich blocks preserves bounded text and its recovery path
when the configured text cap can contain it.

See [Bounded file discovery](file-discovery.md) for glob semantics, sandbox
enumeration and adapter requirements.

## Cancellation preserves evidence

A tool that already returned has executed even if cancellation interrupts its
post-tool hook. The receipt preserves the tool's reported success or failure,
but withholds unreviewed text and rich content because that hook may perform
redaction. The model is told to inspect external state before retrying. Serial
calls still waiting to start receive explicit not-started results, so a later
cancelled call does not discard an earlier completed receipt.
Cancellation also stops retry scheduling. An interrupted review's failure log
uses the withheld diagnostic instead of the tool's unreviewed error text.

The CLI drains a cancelled query through kernel settlement before publishing
its conversation snapshot. It suppresses late display events but retains the
actual tool calls, receipts and provider reasoning for the next turn. Visible
prose alone is insufficient evidence of work already performed.

Provider cancellation does not wait for an async iterator whose pending
`next()` ignores the abort signal. This also holds with the idle watchdog
disabled. The budget records known usage and unresolved spend before the
wrapper settles; an already-issued late usage frame can increase recorded
usage without reopening admission. Cleanup is requested but cannot guarantee
that a non-cooperative provider has stopped remote work.

Shell progress assembles bounded stdout and stderr lines independently on both
host and sandbox paths. Sandbox timeouts retain captured output. A clipping
notice identifies missing evidence without asking the model to repeat a
possibly state-changing command.

Foreground host shells own a separate process group on POSIX. Cancellation,
timeout and output overflow terminate that group, with forced termination after
the three-second grace period. Timeout and command-failure results retain
captured output; caller cancellation still returns the cancellation receipt.
Releasing the owned pipe readers after that grace also bounds cancellation when
a descendant deliberately starts a separate session and keeps an inherited
pipe open. Such a descendant has escaped the group and is not guaranteed to
stop; process-group ownership is not containment.

Output caps apply independently to stdout and stderr. Host failure results name
clipped streams and expose `stdoutTruncated` and `stderrTruncated`, even if the
cap was reached during timeout cleanup. UTF-8 clipping retains complete encoded
characters and does not manufacture a replacement character at the cap boundary.

Linux process regressions exercise real shell, parent and child processes,
including children that ignore graceful termination and children that create
another session. Windows uses the existing process-tree termination helper;
these Linux results do not verify its behavior on Windows or remote sandboxes.

## Delegation accounting

Interactive delegation can release its wait when operator input arrives. The
tool returns a receipt naming the running task; its child stays owned by the
same parent run. The parent receives input after every outstanding tool call
has a matching result, preserving the provider's tool-call ordering. Other
tools continue to observe their normal completion and cancellation contracts.

The CLI and query loop share one `CompletionInbox` per parent run. Results
delivered inline are claimed; results from released waits arrive once as
completion notifications. A finishing parent can wait for outstanding children
without blocking new operator input. Cancellation still stops parent-owned
children. A released tool wait does not cancel its child or mark it completed.
The CLI's `wait_for_task` reads the complete result of a task owned by the same
parent run, including text truncated in notifications; it does not launch a
replacement. Budget stops remain visible beside any retained partial output.

`query()` accepts an optional `waitForInbound(signal)` callback alongside
`inboundMessages()`. The callback observes arrival without consuming messages:
it resolves immediately when unconsumed input exists and releases listeners
when its signal aborts. The normal message callback remains the only consumer.
`CompletionInbox.waitForArrival(timeoutMs, signal?)` likewise releases its wait
on abort while retaining task ownership and undelivered results.

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

## One budget for the delegation tree

The parent and its descendants now share one [token budget ledger](token-budgets.md).
The parent cannot spend a child's reserved allowance. Nested children reserve
from their own parent's account, and measured overshoot remains debt against
every ancestor. A final child result reconciles its own cumulative usage rather
than charging that usage a second time.

The canonical ledger is persisted independently of message checkpoints. Resuming
an older checkpoint retains the latest known spend and outstanding reservations.
A lost provider receipt prevents further admission; it is not treated as zero
usage. `Run.tokenUsage` describes the run itself, while `Run.budget.treeTokens`
includes descendants. The ledger records tokens; dollar limits remain local to
the run and its priced usage.

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

After aggregate accounting was added, a separate one-request check used the
same small model and `low` effort with a 12,000-token cap. It returned the exact
requested marker without tools. Its 4,520 reported tokens matched the live
own/tree counters and the single persisted receipt, leaving 7,480 tokens and
no unresolved requests. It created one Project and emitted one terminal event.
This checks real provider usage reaching the ledger; concurrent delegation and
restart conservation are exercised separately by deterministic regressions.

This establishes the tested file-edit, error-recovery, conversation and root
binding paths. It does not establish long-horizon reliability or a benchmark
score. In particular, visual salience remains a conservative heuristic; tool
schemas and standing instructions still cost tokens on a small task. Future
comparisons need matched model, effort, task, tool interface and measured usage,
with repeated trials before attributing a score difference to the harness.
