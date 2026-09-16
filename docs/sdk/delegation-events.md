---
type: Reference
title: Delegation events
description: What the kernel says when a run delegates — the fields agent_pending carries, which of them a host may act on, and which are captions for a screen.
resource: packages/sdk/src/types/run/events.ts
tags: [sdk, agents, events, bridge]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-16T00:00:00Z }
---

# Delegation events

A run that delegates work reports each delegation on its own listener.
`agent_pending` arrives first, when the child has been created and QUEUED —
before admission, which is what its name and the absent start mean. A child
announced this way has not begun: it waits for a slot under the delegation
capacity limit, for as long as that takes, which is why the CLI shows it as
`Queued` until the child's own `run_started` arrives. Exactly one of
`agent_completed`, `agent_failed` or `agent_canceled` follows when it settles.

`subsession_spawned` reaches the same listener when the child is admitted and
given its own sub-session — immediately after `agent_pending` for a child that
never had to wait. A parent's listener also receives the child's own run
events, each numbered in the child's run log, so a consumer keeps one cursor
per `runId`.

`agent_pending` is the only delegation event that carries identity beyond the
task, and it arrives before the child has produced anything — before it has
started at all. Everything a host wants to know about *where a child belongs*
therefore rides that event.

## What `agent_pending` carries

| Field | Always | Means |
| --- | --- | --- |
| `runId` | yes | the PARENT run, which is whose listener this arrived on |
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
to it in any way a run can observe. `phaseOrder` orders a list on a screen and
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

## Delegation events are not persisted

Reach is not durability, and these events buy only the first.

The agent manager hands every delegation lifecycle event straight to a host's
listener without passing it through the run's event translator, so none of them
enters any run's log — not the parent's and not the child's. That is what the
absent `seq` on these variants means: `seq` is a claim that the event is *in* a
log, and a delegation event has no such claim to make. `RunEvent`'s own `seq`
documentation lists these events as one of the three reasons a number is
missing.

So a label on `agent_pending` is written nowhere by the kernel, and the grouping
does not survive a restart of the host that chose it. A host that wants it to
outlive its process records it from the listener, into whatever store it already
keeps; nothing here does that for it. Note too that `agent_pending` carries the
**parent's** `runId`, so even a host that does persist the event is filing it
under the parent rather than the child.

## What a child does leave behind

The events are not persisted; the child's own run is. A delegated child gets a
`RunStore` like any other run, and the built-in `RunDiskStore` writes it under
its parent:

```
<baseDir>/<parent run id>/children/<child run id>/
    transcript.jsonl   run.json   messages.json   audit.jsonl   report.md
```

`RunDiskStore.addToIndex` returns early for any run carrying a `parentRunId`, so
none of this appears in the browsable `index.json` catalogue — a delegated child
is not a conversation anyone resumes, and listing one there would offer to
continue work whose parent turn is over. That guard is deliberate and stays.

`RunDiskStore.listChildren(baseDir, parentRunId)` is the sibling read for
callers that want the evidence anyway. It walks the `children/` directory,
reads each `run.json`, and returns a `DelegatedChildRun` per child — the run id,
the directory, and whatever the file recorded of `agentId`, `agentName`,
`metadata.config.model`, `status`, `startedAt`, `endedAt`,
`tokenUsage.totalTokens` and `depth`. Every one of those is optional: `run.json`
is written on a run's terminal path, so a child killed before it got there
leaves a transcript worth reading and a record that never recorded an ending,
and an absent field means "the file did not say" rather than zero.

Three properties a caller can rely on. It is **read-only** — binding a
`RunDiskStore` to a run creates that run's directory, which is why this is a
static walk and not a bound method, and nothing here writes, moves or prunes.
It is **tolerant** — a child directory with no `run.json`, or one whose
`run.json` is not readable JSON, is skipped rather than reported with invented
fields or raised as an error. And it is **ordered by `startedAt`, oldest
first**, which is the order the parent launched them; a child with no recorded
start sorts first, because there is no later moment to claim for it.

`listRuns` is unchanged. This is an additional read, not a fix to the catalogue.

Because delegation events are not in the child's log, what a reader recovers
from `transcript.jsonl` is the child's own run: `run_started`, tool calls and
their results, token usage, the completed messages and `run_completed`. The
`agent_pending` that named the child's `workflow` and `phase` is not there, and
neither are the streaming deltas, which never enter a run's log at all.

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
