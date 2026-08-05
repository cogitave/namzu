---
'@namzu/sdk': major
---

A failed worker is reported as a failure, and a plan task can say it failed.

**`create_task` reported a failed worker as a success.** Two layers can disagree
about whether a delegated run succeeded: the gateway's `TaskHandle.state`, and
the run's own `BaseAgentResult.status`. The kernel's `finalizeChild` always calls
`markCompleted`, so `state === 'completed'` holds for a child that ran and
returned `status: 'failed'` — and `create_task` asked only that layer. The model
received the failure text as an answer, the tool result carried
`isError: false`, and the plan task was written closed as though the work had
been done.

The correct two-authority predicate was already written, twenty lines away, in
the canonical `Agent` tool — put there because a review caught it on that site,
and nothing carried the answer to the other one. It now lives in one place both
reach.

**`TaskStatus` gains `failed`, and that is the breaking part.** A unit that did
not succeed had nowhere to say so, which is why a failed delegation was recorded
as `completed` with the failure encoded as prose in `description`: a reader
scanning statuses saw work that had been done, and a dependent unit had no way
to tell at all.

If you switch exhaustively over `TaskStatus`, or hold a `Record<TaskStatus, T>`,
you need a `failed` arm. `isTerminalTaskStatus` now returns `true` for it —
terminal means "will not change on its own", not "succeeded", and a unit blocked
on something that failed would otherwise wait forever for a status that will
never arrive. In the store's transition ranking `failed` sits alongside
`completed` rather than after it, so `in_progress → failed` is allowed and
`completed → failed` is not.

**Two smaller repairs ride along.** A background launch refused for want of a
completion inbox now marks its plan task failed rather than leaving it in
progress with no worker behind it — nothing later closes a task whose launch
never happened. And the `Agent` tool passes `parentSpan` when creating its
child, so a delegated run joins the turn that asked for it instead of starting
its own root trace; `create_task` has done this all along.
