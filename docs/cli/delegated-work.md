---
type: HowTo
title: Delegated work
description: Launch independent child work, queue corrections and observe completion without losing ownership.
resource: packages/cli/src/integrations/subagents/runtime.ts
tags: [cli, agents, concurrency]
---

# Delegated work

The `Agent` tool normally waits for its result. Set `run_in_background: true`
to receive the task UUID after launch and continue independent work. A queued
task is waiting for capacity; the receipt does not claim it has started or
completed. The permission review shows the background choice and full task.

`send_message` takes `task_id` and `message` and queues a correction for a running
or queued child owned by the current parent run. The child reads it at its next
request boundary. Acceptance confirms queuing, not delivery or execution.
Messages are bounded to 16,000 characters. Finished tasks cannot be restarted
through this tool, and another parent's task cannot receive the message.

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
