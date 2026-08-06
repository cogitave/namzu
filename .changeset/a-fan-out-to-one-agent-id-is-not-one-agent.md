---
'@namzu/sdk': minor
---

A fan-out naming the same agent runs every child instead of one.

`AgentRegistry` hands out ONE `typedAgent` per registered id, and an agent
instance refuses a second concurrent `run` — correctly, because its abort
controller and run id are instance state and two overlapping runs would cancel
each other. So four `create_task` calls naming the same `agent_id` drove four
runs at one shell: one produced a result and three died with
`ConcurrentInvocationError`, while `create_task`'s own description tells a model
that exactly this fan-out is the thing to do.

The remedy was already written down — "a host that wants parallelism constructs
a second instance" — and was unreachable from delegation, where the definition
owns the instance and the caller has only an id.

`Agent` gains an optional `forRun()`, implemented by `AbstractAgent`, returning
a fresh shell of the same class built from the same metadata. `AgentManager`
takes one per spawn. Nothing else about a child was ever shared: its abort
signal is the task's own, its config is rebuilt per spawn by `configBuilder`,
and the manager cancels through the task rather than the agent. The shell was
the last shared thing.

`AgentDefinition` also gains `createAgent?`, which wins over `forRun` — for an
agent that needs real construction arguments, which a metadata-only rebuild
cannot supply. Most hosts need nothing: agents built on `AbstractAgent` already
work.

The lock is unchanged and still refuses. That refusal is right for a host
calling `run` twice on one instance on purpose; what changed is that delegation
no longer does so by accident. Loosening the lock instead would have been the
smaller diff and the wrong one — the state it guards is genuinely instance
state, and serialising same-agent spawns behind it would deadlock a child that
spawns a grandchild of its own id.

Its message now names the remedy rather than only the refusal.

Found by running a four-way fan-out against the published package, not by a
test.
