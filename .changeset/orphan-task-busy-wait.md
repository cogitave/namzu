---
'@namzu/sdk': patch
---

Remove the dead task-notification busy-wait that could hang a run for minutes.

When the model ended its turn while the task gateway still listed a running
agent task, the iteration loop polled an internal `pendingNotifications`
queue every 250ms for up to `runConfig.timeoutMs` (120s default) — but
nothing has pushed onto that queue since the `onTaskCompleted` listener was
removed: every dispatch tool (`create_task`, `continue_task`, `Agent`) is
blocking and already returns the worker's output as the dispatching
tool_use's canonical `tool_result`. The wait always injected nothing, then
re-invoked the model with an unchanged conversation, so runs with an orphaned
task (an interrupted tool execution, a cancel race) sporadically stalled for
multiples of the timeout before finishing with the answer they already had.

The superseded `<task-notification>` envelope path is now fully torn out
(`waitAndInjectNotifications`, `injectOneTaskNotification`, the
`pendingNotifications` queue and its XML/CDATA helpers). End-of-turn
semantics with orphan running tasks are explicit: the run ends normally
(`end_turn`) and a warning is logged that the orphans have no delivery path.
Runs without orphan tasks are byte-identical.
