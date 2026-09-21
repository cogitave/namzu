---
type: Reference
title: Delegation events
description: What the kernel says when a turn delegates to a child session — the fields agent_pending carries, which of them a host may act on, which are captions for a screen, and what the parent and child logs keep.
resource: packages/sdk/src/types/session/events.ts
tags: [sdk, agents, events, bridge, sessions]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-16T00:00:00Z }
---

# Delegation events

A turn that delegates work reports each delegation on its own listener. A
delegated agent runs in a **child session** of its own.

`agent_pending` arrives first, when the child has been created and QUEUED —
before admission, which is what its name and the absent start mean. A child
announced this way has not begun: it waits for a slot under the delegation
capacity limit, for as long as that takes, which is why the CLI shows it as
`Queued` until the child's own `turn_started` arrives. Exactly one of
`agent_completed`, `agent_failed` or `agent_canceled` follows when it settles.

`child_session_spawned` reaches the same listener when the child is admitted
and given its session — immediately after `agent_pending` for a child that
never had to wait. A parent's listener also receives the child's own session
events. Each carries the child's `sessionId` and a `lineage` whose `depth` is
above zero, and each is numbered in the child's own log, so a consumer keeps
one cursor per `sessionId` and can filter children out by `lineage.depth`.

`agent_pending` is the only delegation event that carries identity beyond the
task, and it arrives before the child has produced anything — before it has
started at all. Everything a host wants to know about *where a child belongs*
therefore rides that event.

## What `agent_pending` carries

| Field | Always | Means |
| --- | --- | --- |
| `sessionId`, `turnId` | yes | the PARENT session and the turn that delegated, which is whose listener this arrived on |
| `taskId` | yes | the delegated task, the id every later `agent_*` event repeats |
| `parentAgentId`, `childAgentId` | yes | who delegated, and to which agent definition |
| `depth` | yes | how far below the root session this child sits |
| `planId`, `planStepId` | when the delegation came from an approved plan step | correlation a host **may act on**: the plan edge that authorised this work |
| `workflow`, `phase`, `phaseDetail`, `phaseOrder` | when the delegating host supplied them | display grouping: **captions**, see below |

## Display labels are captions

`workflow`, `phase`, `phaseDetail` and `phaseOrder` are supplied by the host
that called for the delegation, and are the labels it wants the operator to see
the child grouped under. They are display annotations only; they do not create
dependencies, barriers, or serial execution.

Nothing in the kernel reads them back. Admission, capacity, ordering and
concurrency are decided by the scheduler; a child naming the same `phase` as
another child is not thereby sequenced after it, made to wait for it, or joined
to it in any way a turn can observe. `phaseOrder` orders a list on a screen and
orders nothing that runs.

`planId` and `planStepId` are the opposite kind of field and sit beside them for
the contrast: those name an approved plan edge, and a host that acts on them is
acting on something the kernel also knows about.

The labels ride the event rather than staying in the delegating process for one
thing a process-local label cannot buy: **reach**. A consumer watching the event
stream from elsewhere — another listener, or an SSE client — rebuilds the same
grouping instead of seeing an undifferentiated list of children. A label held in
the delegating process's memory is visible to that process and to nothing else.

Every field is optional and absent by default. A host that groups nothing sends
nothing, and a consumer written before these fields existed reads exactly the
event it read before.

## What the logs keep

The durable record of a delegation is in the [session logs](session-log.md),
not in the listener's stream.

- **The parent's log** records `child_session_spawned` when the child is
  admitted: the child's session id, the tool call that spawned it, its kind and
  description, the relative path of its log, and — when the host supplied a
  workflow — a `batch` of `{ batchId, name, phase? }`. It records
  `child_session_ended` when the child settles: its status, stop reason, usage,
  cost and the id of its answer message. So the workflow and phase **do**
  survive a restart; `phaseDetail` and `phaseOrder`, which are hints for one
  screen, do not.
- **The child's own log** is `<parent-session-id>/subagents/<child-id>.jsonl`,
  beside `<child-id>.meta.json`, which names the parent session, the parent
  turn, the root session, depth, the spawning tool call, agent type,
  description and status. A child's own children nest the same way. The meta
  file is a convenience: the child's log wins on any disagreement.

Reading them back needs no directory walk. `SessionIndex.listChildren(parent)`
returns a `ChildSessionSummary` per child — its session, the parent turn and
tool call, kind, description, `batch`, status (`running` until the parent
records the end), stop reason, tokens, cost and times — with the child's own
indexed session once its log has been read. `SessionIndex.batches()` groups
them by `batch`. Both come from the index, which is rebuilt from the logs, so
they are read-only and never create, move or prune anything.

The child's log holds the child's own turns: `turn_started`, every complete
message, tool calls and their results, token usage and `turn_completed` or
`turn_failed`. Streaming deltas never enter any log.

A child session is not a conversation anyone resumes: `listSessions({
rootsOnly: true })` leaves it out, and it is reached through its parent.

## Supplying them

A host names them on the options it already passes when delegating —
`CreateTaskOptions` for a scheduler, `SendMessageOptions` for the agent manager
underneath it — and they arrive on the event the child's `agent_pending`
produces. The CLI's `Agent` tool is one such host; see
[delegated work](../cli/delegated-work.md).

```ts sketch
await scheduler.createTask({
  agentId: 'general-purpose',
  prompt: 'Read the two mappers against this fixture.',
  workingDirectory: cwd,
  workflow: 'Release audit',
  phase: 'Verify',
  phaseOrder: 1,
  phaseDetail: 'Confirm the fix against the failing case.',
})
```

A host is expected to give every child in one phase the same `phaseOrder`. A
consumer that sees two disagree should keep the first rather than resequence:
nothing here is authoritative enough to arbitrate, and a list that reorders
itself while work is running is worse than one that is slightly wrong.

## On the bridges

The SSE bridge maps `agent_pending` to the wire event `agent.pending` through an
explicit field allowlist. The labels travel as `workflow`, `phase`,
`phase_detail` and `phase_order`, each present only when the host supplied it —
a key that was always present would tell a consumer that work had been grouped
when it had not.

The A2A bridge maps every delegation event to `null`, and the labels change
nothing about that. A peer asked for one task and models one task lifecycle: how
this runtime divided that work internally is not a fact about the peer's task,
and caption text for an operator's screen is not something a peer has a screen
to put on. A host that wants the grouping reads the SSE wire.
