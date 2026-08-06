---
'@namzu/sdk': major
---

`agent_task_list` and `wait_for_task` are scoped to the run that launched the task.

A supervisor could read a sibling run's worker output by listing.
`SupervisorAgentConfig.gateway` exists so a host can hand the SAME gateway to
several runs, which makes `TaskGateway.listTasks()` gateway-wide by design —
and `agent_task_list` handed that straight to the model, including each task's
`result`, the worker's actual output. `wait_for_task` had the same reach through
`getTask`.

`CompletionInbox` closed exactly this on the push side, because
`onTaskCompleted` is a broadcast and a shared gateway would otherwise hand each
supervisor the other's completions. The pull side kept no such record and asked
the gateway directly, so the same leak stayed open through a different door.

The scope lives in the coordinator tools rather than in `listTasks()`, because
the two answer different questions. A host calling `listTasks()` is the operator
and may legitimately want everything on its gateway; a model calling
`agent_task_list` is one run asking about its own work. Narrowing the gateway
method would take the operator's view away in order to fix the model's.

`wait_for_task` gives the same answer for a sibling's task as for one that never
existed. Distinguishing them would confirm a task id to a run that was not
supposed to know it — the leak in miniature.

**Breaking, for a host that shares one gateway across runs.** A run now sees
only the tasks it launched through its own `create_task`. If you relied on one
run listing another's tasks, that path is closed; use `TaskGateway.listTasks()`
from the host, which is unchanged and still gateway-wide.

**Also breaking in a narrower way:** a task launched through a DIFFERENT surface
on the same gateway — `buildAgentTool`, or the host directly — is not listed by
these tools. That is the same rule rather than an exception to it, but it is a
behaviour change if you mixed surfaces on one gateway and listed through the
coordinator.
