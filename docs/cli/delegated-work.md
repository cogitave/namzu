---
type: HowTo
title: Delegated work
description: Launch independent child work, queue corrections and observe completion without losing ownership.
resource: packages/cli/src/integrations/subagents/runtime.ts
tags: [cli, agents, concurrency]
---

# Delegated work

When the parent mounts independent `web_search` (Exa), delegated agents receive
the same search tool, including read-only `explore` agents. Each call owns its
connection and cancellation. Search remains subject to the parent’s authorization
rules. This does not enable search when it is off or substitute live Exa search
for an explicitly native/cached-only configuration.

Before constructing a delegated Anthropic client or querying its model catalogue,
the session rereads the selected credential owner. File-backed OAuth credentials
are renewed when needed, with concurrent renewals serialized; borrowed keychain
credentials remain owner-refreshed. A removed or still-expired credential stops
client construction instead of reusing the token captured at startup.

The `Agent` tool normally waits for its result. Set `run_in_background: true`
to receive the task UUID after launch and continue independent work. A queued
task is waiting for capacity; the receipt does not claim it has started or
completed. The permission review opens a compact task plan: each agent has one bracketed
row with its task and tool access, grouped by the supplied workflow and phase
labels. Background execution is marked on that row. Long rows wrap on narrow
terminals and large batches remain paged. Press `d` for full instructions and
exact prepared arguments; evolved input shapes still open in the exact view.
These labels do not imply dependencies or additional planned phases.
An optional `phase_detail` string adds explanatory text to a phase, shown
beneath its header in the compact plan and — in the agent cockpit — beneath
the phase list only while that phase is focused. It is display-only, exactly
like `workflow`, `phase` and `phase_order`: it creates no dependencies,
barriers or serial execution. The first agent to declare a phase's detail
sets it; a later sibling in the same phase cannot change it.

Reviews identify the requesting agent by its exact run ID in the activity monitor. If the run has not appeared in the monitor, the full run ID is shown instead of guessing an agent. This attribution stays with each queued review.

Concurrent permission requests are queued in arrival order. The current review
shows how many more requests await approval. Approving or declining it answers
only that request; the next review starts with a fresh consent window. Explicit
session-wide approval also approves requests already waiting in this queue.
Escape declines the current request; Ctrl+C rejects all pending requests and
stops the turn. Closing the application rejects unresolved reviews.

`send_message` takes `task_id` and `message` and queues a correction for a running
or queued child owned by the current parent run. The child reads it at its next
request boundary. Acceptance confirms queuing, not delivery or execution.
Messages are bounded to 16,000 characters. Finished tasks cannot be restarted
through this tool, and another parent's task cannot receive the message.

Once delivery is confirmed — never for a refused or unowned attempt — the
message becomes visible on both sides of the exchange. The child's transcript
(Ctrl+T, Enter to drill in) gets a `← from parent: …` row alongside its tool
calls and answers. The main conversation gets a matching row, `<description> ·
correction sent`, with the message text beneath it, so the operator can see
what was said without opening the child's screen. Each side shows the message
exactly once, however many times the surface re-renders.

Each observed agent completion adds one named status row to the main transcript,
whether or not the model calls `wait_for_task`. A correlated wait shows
`Waiting · <task name>` while active; its successful protocol response does not
add a second report to the transcript. Unknown waits and tool errors remain
visible. Press Ctrl+T to inspect agent transcripts and results. Failed, cancelled
and incomplete work keeps its reported status rather than appearing completed.

Completion reaches the parent as a task notification. `wait_for_task` retrieves
the result without launching duplicate work. Background work keeps the same
parent authority, shared tree budget, capacity limit and cancellation boundary.
It is not a detached service: cancelling or releasing the parent run cancels its
remaining children. A normal parent query waits for owned children before final
settlement, but can perform other tools and handle operator input meanwhile.

Workflow and phase labels describe the display; they do not establish execution
dependencies. Only delegate work that can proceed independently. The CLI's
`bash`, `write` and `edit` tools use [execution barriers](../sdk/tool-execution.md)
inside a model batch, so a following verification read sees completed foreground
mutations. A background shell command releases that barrier after job launch;
wait for the job before reading its eventual output.

Both kinds of annotation now reach a host the same way, on the child's initial
`agent_pending` event, so what separates them is what they mean rather than
where they travel. When an `Agent` call is associated with the active plan step,
the scheduler retains that plan and step identity while the child is queued and
after it is admitted, and SDK hosts receive `planId` and `planStepId` (SSE
consumers: `plan_id` and `plan_step_id`) — correlation a host may act on,
naming an approved plan edge the kernel also knows about. The `workflow`,
`phase`, `phase_detail` and `phase_order` supplied on the same call ride that
event too, as `workflow`, `phase`, `phaseDetail` and `phaseOrder` (SSE:
`workflow`, `phase`, `phase_detail`, `phase_order`), and they remain display
annotations only: they create no dependencies, barriers or serial execution, and
nothing in the kernel reads them back. Carrying them there is what gives the
grouping reach: a listener or SSE consumer outside this process sees the same
grouping instead of a flat list of children, where a label held in the tool
call's own memory would reach nobody. It does not make the grouping durable —
delegation events go straight to a host's listener and enter no run's log, so
nothing here survives a restart unless a host records it itself.
Every one of these fields is absent unless supplied. See
[delegation events](../sdk/delegation-events.md) for the full event surface.


For parallel work, send the independent Agent calls in the same response or
launch them with `run_in_background: true` before waiting. One blocking call
followed by another is sequential. A wait released by operator input returns
the task name, ID and observed state; it does not cancel or restart the task.
The receipt directs the parent to answer the operator before further calls.
This is model guidance, not a deterministic guarantee about its next response.

The SDK also projects a bounded [owned-work snapshot](../sdk/step-context.md#derived-work-context)
before model requests. A task's scheduler state and delivery of its result are
separate fields: neither claims that the parent has summarized the result for
the operator. This keeps owned work explicit after a steering question without
duplicating worker output or adding another persistent task store.


`agent_task_list` reads the current parent run's actual scheduler invocations,
including pending, running and terminal tasks. It returns the most recent 40
with an explicit omitted count. `task_list` remains the planning checklist; an
empty checklist says nothing about running agents. `wait_for_task` retrieves
results by task ID. A budget or other non-normal stop is `incomplete`, even
when the scheduler lifecycle is `completed`; it is not a successful review.

Ctrl+T opens a dedicated agent browser using the terminal's available height.
The main composer is hidden there, with its draft preserved. Ctrl+T returns to
chat; Enter inspects a child transcript, Esc goes back and `q` returns from the
child to the parent. Workflows and phases remain navigation groups, not execution
dependencies. A phase's `phase_detail`, when supplied, is revealed beneath the
phase list only while that phase is focused — the other phases show none, and
a phase with no detail renders exactly as it did before this text existed. The
text wraps to the pane width and is clipped to a fixed number of lines, so the
pane's height never depends on how long the detail is. On a short terminal
(the cockpit's compact layout) the detail stays hidden entirely, the same way
the cockpit already drops its other secondary text there.

Each row in the automatic rail, the agent cockpit and the child transcript
header shows the child's status, elapsed time, description and — when the
host reported them — its resolved model and live counters: cumulative spend
compacted to `42.1k`/`1.38M` and a `· N tools` tool-call count, both drawn
from the same run events the transcript itself renders and never a percentage
or fill bar. Spend is the child's cumulative usage, not its current context
size, which is a different number that falls on compaction. A child that has
not yet reported usage shows an em dash rather than `0`, since the two are
different facts. On a narrow terminal the counters are the first thing
dropped, then the model name; the status, elapsed time and description remain
legible at any width this browser supports. A resolved model id is
host-reported, unbounded text — a self-hosted or gateway-style id can run
well past what a row has room for — so the label itself is capped to a short
budget with an ellipsis before it is ever placed next to the description,
rather than being shown in full and left to crowd the description out.

## Run limits

Built-in children use the configured [run limits](run-limits.md), including
explicit unlimited values. `limits.maxIterations` now reaches built-in children
as well as the parent; absent or zero means unlimited. Built-in children also
default to unlimited run duration. `/config` → Run limits changes these values
for newly started turns and their children without changing already running work.
`limits.timeoutMs` controls the parent and child run deadlines. Delegation waits
remain cancellable and are governed by those runs, so a session-wide tool
deadline cannot override a later `/config` change. Zero removes the run deadlines.
File-defined agents keep their own iteration settings and remain subject to the
shared token ledger. Disabling a local token cap cannot remove a finite ancestor
allowance.

## Child model selection

`Agent` accepts optional `model`, `provider` and `effort` fields. With no selection,
the child inherits the session model (or its file-defined agent model). Provider
and effort overrides require an explicit model. Selection creates a separate
provider instance and never switches the parent conversation. Explicit provider,
model and effort are visible in the compact approval plan and its detailed view. The child's tool
allowlist, read-only scope and review authority remain unchanged.

Use `agent_models` with an optional `query` filter to discover connected model IDs
and published capabilities. Results are bounded to 40 with an omitted count.
Unknown capability fields are not interpreted as unsupported, and the catalogue
is not an empirical quality ranking. Explicit model and effort selections are
validated before a task is created. Drivers whose effort menus come from model
discovery load their catalogue on each fresh validation/execution instance; unavailable selections are reported without
silently substituting another model.

CLI delegation has no implicit cumulative token cap when `limits.tokenBudget`
is omitted. An explicitly finite tree budget still constrains every child, and
usage remains recorded in unlimited mode. Other execution limits are unchanged.

## Cancelling one agent

`cancel_agent` takes the exact `task_id` returned by `Agent` or `agent_task_list`.
It requests cancellation only for a running or queued task owned by the invoking
parent run. Other tasks keep their ownership and cancellation signals. A finished
task returns its existing status without restarting or cancelling anything.
The receipt says cancellation was requested; use `agent_task_list` or
`wait_for_task` to confirm the terminal outcome. Task results still reach the
completion inbox once.

Cancellation during an unresolved provider stream can leave unknown token spend.
The ledger retains the unknown receipt and blocks its owning account and branches
sharing a finite ancestor budget. Healthy siblings under unlimited ancestors can
continue. `/cost` reports unresolved receipts and labels totals as measured,
potentially incomplete usage. Invalid accounting or failed persistence still
blocks the whole tree. A tool wait after a settled provider receipt does not
introduce this uncertainty.

## Saved delegation evidence after resume

The CLI saves session-scoped task receipts in its private project state under
`delegation-history/<session UUID>/`. Each admitted task gets an `unresolved`
receipt; observed termination replaces it with the actual outcome and a result
preview of at most 16,000 characters. Truncated previews are explicitly marked.
A completed scheduler lifecycle does not turn a token-limited result into success.

New turns and checkpoint resumes take one bounded archive snapshot of earlier runs'
receipts. Use `agent_task_list({history: true})` to inspect the archive and
`agent_task_list({history: true, task_id: "<UUID>"})` to read one saved result.
The normal tool call still lists live tasks owned by the current run. Historical
access grants no cancellation, messaging or execution authority.

`unresolved` means no terminal receipt was saved. It does not prove that the task
is still running, failed, or had no effects. Resume does not automatically restart
these tasks or reconnect their processes. Verify existing effects before deciding
to repeat work. A crash between task admission and receipt publication can still
leave no receipt; this archive is not an exactly-once execution journal.

Archive listings read at most 200 receipt files and return at most 20 records;
the omitted count discloses the remainder. Exact-ID reads can retrieve a record
outside that listing. Model context includes at most eight earlier records and
omits the summary under tight context pressure. Corrupt records produce an error
rather than an apparently empty history.

Agent transcript pages wrap prose at word boundaries. Long unbroken URLs or
code still wrap at grapheme boundaries, preserving all retained characters.
