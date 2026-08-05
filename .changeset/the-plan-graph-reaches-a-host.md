---
'@namzu/sdk': minor
---

A host can see the fan-out gate, and the plan graph the model is already keeping.

**`SupervisorAgentConfig` gains `maxToolConcurrency`.** The kernel has honoured
it all along and `ReactiveAgent` forwards it — it was missing on the one agent
whose entire job is delegation. So the agent that fans out could not set the gate
that bounds a fan-out, while the agent that does not fan out could, and a host
wanting a narrower one had to reach past the supervisor to `drainQuery`.

Note what it bounds: how many delegated children run **concurrently**, not how
many a turn may launch. A model emitting twenty `create_task` blocks still
launches twenty; they queue.

**`task_created` and `task_updated` carry `blockedBy`.** The task store
maintains a full dependency graph — `blocks` and `blockedBy` mirrored on both
ends, written under a lock, deadlock-avoided — and none of it reached the wire.
A host could draw a flat list of units and nothing about their order, while the
model was already maintaining the order.

Absent rather than empty when a unit depends on nothing, so a reader can tell
"no dependencies" from an emitter that predates the field.

**And `block()` announced nothing at all.** Both stores wrote the edge and
emitted no event, so the graph was observable only by polling: a listener saw a
unit created and never learned that something now waits on it. Both stores now
announce **both ends**, because both changed — a host tracking one side would
draw half the edge. The disk store announces only when something actually
changed, so re-establishing an existing edge stays silent.

That second half is the one worth knowing about if you consume these events: the
field alone would have been useless, because the moment a dependency is created
was never on the wire in the first place.
