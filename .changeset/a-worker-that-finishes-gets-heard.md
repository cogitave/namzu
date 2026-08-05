---
'@namzu/sdk': minor
---

a worker that finishes now reaches the supervisor, without polling for it

A delegated worker's output reaches the supervisor as the `tool_result` of
the `create_task` that launched it. That works while the launching call is
still the live path — and there are two situations where it is not:

- the call hit the executor's deadline. The model was told *"timed out… it
  may still be running"*, with no task id, and the worker then finished
  normally holding a result nothing would ever read.
- there was never a call waiting, because the launch was meant to run
  alongside the turn.

In both cases the completion existed, the gateway remembered it, and the
supervisor was never told. The one tool left to it, `agent_task_list`,
reported id, state and duration — and dropped the worker's output, reading
`result.status` and `result.lastError` off the handle while stepping over
`result.result` between them. So a supervisor could learn that a task had
definitely finished and still have no way to read what it said.
`agent_task_list` in a sleep loop was not the model misbehaving; it was the
only move on the board.

**Completions are now delivered rather than polled for.** A run subscribes
once through `onTaskCompleted` — which every `TaskGateway` already has, so
no gateway changes — and anything a tool did not hand over inline arrives in
the transcript as a task notification carrying the id, the agent, the state
and the output.

The distinction is the whole design. An earlier version of this channel was
removed because it fired for completions the blocking tool had *already*
delivered, so the supervisor saw each result twice. Tools now claim what they
deliver, and only unclaimed completions are announced. A blocking
`create_task` behaves exactly as it did.

Three additions come with it:

- `create_task` takes `background: true`, returning a `task_id` immediately
  so the supervisor can keep working.
- `wait_for_task` joins a running task and returns its output. `continue_task`
  blocked, but only as a side effect of sending a message, so a supervisor
  that merely wanted to wait had to invent something to say.
- `cancel_task` is mounted again. It was dropped on the reasoning that a
  blocking launch leaves every worker terminal before its id is known — true
  then, and untrue now that a background launch hands back a live one.

`agent_task_list` also carries the worker's output, in the rendered text
rather than only in `data`: the executor builds the model-facing tool result
from `output` alone, so a field added to `data` would have been added
somewhere the model cannot see.

A run no longer settles while a background worker it launched is still
running — it would have discarded the very result the launch existed to
produce. The wait is bounded, so a worker that never finishes cannot hold a
run open.

`CompletionInbox` and `formatCompletionNotification` are exported for hosts
that build the coordinator surface themselves.
