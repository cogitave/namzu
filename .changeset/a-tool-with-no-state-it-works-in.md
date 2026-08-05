---
'@namzu/sdk': patch
---

`continue_task` is deleted rather than left defined and unreachable

It was written, documented, and never returned from the coordinator builder —
so no model could call it. The question was reopened when `background: true`
made a live task id reachable again, since the reason it was dropped had been
that a blocking launch leaves every worker terminal before a later turn learns
its id, and the manager refuses `continue` on a terminal task.

Measured instead of assumed, and it fails on the other side. On a LIVE task the
manager accepts the call and pushes onto `pendingMessages` — and **nothing
drains that queue during a run**. The codebase already knew: `steering.ts` says
in as many words that `queueMessage`/`drainMessages` were never read by the
iteration loop, and `SteeringChannel` exists because of it, delivering guidance
on a tool result instead — a `tool_use` must be answered by a `tool_result`
with the same id, so there is no legal slot for a user message mid-batch.

So the tool had no state it worked in: terminal tasks refuse it, live tasks
accept it into a queue nobody reads. Registering it would have handed the model
a call that silently does nothing, which is worse than an unreachable
definition — an unreachable one at least cannot be called.

If follow-ups on a live worker are wanted, the work is a consumer for the queue
or a steering channel that reaches a child. Not this tool.
