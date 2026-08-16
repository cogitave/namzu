---
'@namzu/sdk': minor
---

Text queued for a running agent is now delivered at the next-turn boundary.
Two public APIs could accept it and silently never hand it over.

`AgentManager.continueTask` and `queueMessage` pushed onto
`pendingMessages`, and nothing in the kernel ever drained it — the manager
interface's own docblock said "the runtime does not deliver it", and
`continue_task` was unmounted from the coordinator tools because of that.
So a supervisor could redirect a running worker through a public API and
have the instruction go nowhere.

The steering channel had the mirror-image hole. It can only append to a
settled tool result, so guidance queued during a turn that called no tools
stayed pending, and the loop ended the run with the channel still full.

`BaseAgentConfig.inboundMessages` is the delivery seam: a drain callback,
stamped on a child's config after its `configBuilder` returns for the same
reason `parentSpan`, `resumeHandler` and `env` are — a builder written by
whoever registered the agent cannot forward a field it was never told
about. Both queues drain at the iteration boundary, beside the completion
inbox, which is the established place for putting a user message in after
tool results and before the next turn.

An empty queue costs nothing: no extra iteration, no model call, no message
in the history. A queued message costs exactly one more turn.

`queueMessage` on a settled task now throws instead of pushing silently.
There is no longer a state in which a caller believes something is in
flight when the only thing that would have drained it has finished.
