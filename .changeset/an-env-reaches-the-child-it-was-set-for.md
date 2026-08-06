---
'@namzu/sdk': minor
---

An environment reaches the child it was set for.

`AgentManager` builds a delegated child's config on two branches. The
bare-config branch — taken only when a definition has no `configBuilder` — has
always carried `env`. The `configBuilder` branch, which is what a host
registering a real agent actually uses, never stamped it. So a run given an
environment handed its delegates none of it, and the child ran against whatever
the ambient defaults were.

This is the third field to go the same way. `parentSpan` and `resumeHandler` are
both stamped after the builder returns, each with a comment saying the builder is
written by whoever registered the agent and cannot be expected to forward
something it was never told about. `env` was missed, and it went unnoticed
because a missing environment does not fail — the child just runs somewhere else.

Both delegation surfaces now forward the parent's `ToolContext.env` as a
`configOverrides.env`, and the manager merges it **per key** rather than
replacing the map: `configOverrides` is a `Partial`, so assignment would drop
every key the builder set and the caller did not restate. The override wins per
key, the same direction it already wins for `model`, `thinking` and `effort`.

**Widening worth naming:** a delegating agent's `config.env` now reaches every
descendant, on both surfaces. That is what setting an environment was for, and
it is a behaviour change for anyone who had been relying on delegates not
inheriting one.

**`env` is for configuration, not credentials**, and the contract now says so
where it is declared. The map is copied into every descendant, is readable by
any tool, and enters a model's context and the run transcript the moment a
command echoes it — properties of the channel, not a judgement about any
particular value. A value that authenticates to a host belongs on the brokered
credential path, where the process holds a placeholder and the value is attached
at egress.

No new field on `ProjectConfig`. It already carries six fields nothing reads,
and a workspace environment does not need a seventh: the mechanism is the
environment a run is given, which now actually propagates.
