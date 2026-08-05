---
'@namzu/sdk': minor
---

A run that ends over a still-running worker says so, and the untrusted envelope's own label can no longer close it

Three things an adversarial review of the completion path found.

**`Run.abandonedTaskIds`.** A run can settle while a worker it launched is
still going — the model answered, a terminal tool decided the result, a
`stopWhen` fired. Until now nothing said so, which left the impression the
worker's result had been delivered. The run now names those task ids.

They are **named, not cancelled**, and that is the decision: giving up on a
wait is a statement about the waiter, not about the work — the rule this
subsystem already applies to `wait_for_task` — and "the parent answered early"
is a weaker warrant for killing a child than "the clock ran out", not a
stronger one. A worker mid-write is not the kernel's to judge. A host that
wants the work stopped has `cancel_task` and the run's abort controller, and
now has the ids to use them on.

**`wrapUntrusted` neutralises its own delimiter inside `provenance`.** The body
was defanged and the attributes escaped; the provenance line was interpolated
raw, and every caller in the SDK builds it from a value it did not author — an
agent id from a roster, a server name from a connector manifest. A provenance
carrying `</namzu-untrusted>` ended the block before the content it was
introducing. This affects the blocking `create_task`, `wait_for_task` and the
`Agent` tool as well as the two paths framed in this release.

**`background: true` with no inbox is refused, not silently made blocking**,
and the sentences match. The abandoned-wait messages on `create_task` and
`wait_for_task` promised "its result will arrive separately as a task
notification" unconditionally — false with no inbox, and a model told to expect
a message waits for it. They now say where the result actually is. The
`agent_task_list` description likewise stops telling the model not to use the
listing when, without an inbox, the listing is the only route left to an
abandoned launch's output.

`CompletionInbox` gains `outstandingTaskIds`, which reads the ids and cancels
nothing.
