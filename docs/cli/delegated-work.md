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


For parallel work, send the independent Agent calls in the same response or
launch them with `run_in_background: true` before waiting. One blocking call
followed by another is sequential. A wait released by operator input returns
the task name, ID and observed state; it does not cancel or restart the task.
The receipt directs the parent to answer the operator before further calls.
This is model guidance, not a deterministic guarantee about its next response.


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
dependencies.

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
