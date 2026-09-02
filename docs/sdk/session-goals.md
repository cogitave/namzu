---
title: Session-owned completion goals
description: Reference for durable completion goals in @namzu/sdk, including Session authority, exact revisions, lifecycle transitions, disk publication, and the boundary between goal state and automatic continuation.
type: Reference
status: stable
resource: packages/sdk/src/store/goal/index.ts
tags: [sdk, sessions, goals, durability]
generated: { by: human:bahadirarda, at: 2026-08-18T00:00:00Z }
---

# Session-owned completion goals

A `SessionGoal` is the durable state around one completion objective owned by
one `Session`. The objective is the text to achieve; the goal is the identity,
lifecycle, revision, and ownership around that text. It is not a
topic objective: a topic may outlive several conversations, while this state
must follow exactly one resumable conversation.

`InMemorySessionGoalStore` and `DiskSessionGoalStore` implement the same
`SessionGoalStore` contract. Both require a `SessionStore` authority. Every
read and mutation first proves that the session exists and belongs to the
requesting tenant. A format-valid but unknown session id is refused, and one
tenant cannot reserve another tenant's session id by creating goal state first.

## Lifecycle

A new goal starts in `active` with revision `1`. The store accepts these
transitions:

| Operation | Accepted phase | Result |
|---|---|---|
| edit | active, paused, blocked | Same goal identity with a new revision |
| pause | active | paused |
| resume | paused, blocked | active |
| admit round | active below its cap | Same goal identity, new revision, and one durable admission |
| block | active | blocked with a machine code and human message |
| complete | active, paused, blocked | complete |
| clear | any current goal | No current goal, with a durable tombstone |

Each mutation takes a `GoalRef` containing both the goal id and its exact
revision. A stale writer receives `StaleGoalError`; invalid lifecycle movement
receives `GoalTransitionError`. An unfinished goal cannot be overwritten by a
second create. After clear or completion, a create receives a fresh goal id and
starts its public revision at `1`.

The objective is trimmed, must be non-empty, and is bounded at 4,000 Unicode
code points. A block reason uses a lower-kebab-case code and a non-empty human
message. `maxGoalRounds` is a positive safe integer and defaults to `256`;
`roundsAdmitted` starts at zero.

## Round admission and authority

`admitRound(sessionId, tenantId, exactRef)` durably reserves one automatic
round before provider work begins. It increments both the public goal revision
and `roundsAdmitted`, then returns a readonly `GoalRoundAuthority` carrying
the session, tenant, goal, post-admission revision, objective, one-based round,
and cap. “Admitted” is literal: a crash after this commit may consume a slot
without proving that a provider began or completed work.

When all admitted slots have been consumed, the next admission attempt commits
the goal as `blocked` with reason code `round-limit` and throws
`GoalRoundLimitError` containing that durable winner. This makes a finite cap a
store invariant rather than a host-side counter. Concurrent callers presenting
one revision still admit exactly one round.

`buildSessionGoalTools` supplies `get_goal` and `update_goal` for a host that can
resolve an exact authority from the current run id. Registration is not enough:
the host must also remove these names from provider manifests and executor
capabilities on every ordinary and child run. An admitted run may mark only its
exact current goal complete. Model-reported blocking additionally requires the
third admitted round and a machine code plus human-readable reason. Direct host
lifecycle operations remain governed by the store transitions above.

## Disk durability

The disk implementation writes below `<rootDir>/goals/`. Public goal revisions
restart for a fresh goal identity, so the record also carries a private storage
sequence that continues across completion, clear tombstones, and replacement.
That sequence is published through immutable revision commits. Competing
processes may propose the same next goal revision, but exactly one can commit;
the others re-evaluate against the winner and refuse with the domain error.

The compatibility projection is not the commit. Readers use the immutable head
and refuse a damaged or incompatible mixed-writer state instead of choosing a
plausible record.

## Host-control boundary

The kernel command registry exposes `/goal` only when a host supplies a
`GoalCommandScope` containing the store, session id, and tenant id. Without that
durable scope the command refuses rather than inventing process-local state.
The command is direct host control and is not registered as a model-visible
tool. `SessionGoalActivation` is a separate process-local permission: hosts arm
it after explicit create or resume, advance it after admission, and use exact
disarm so an old turn cannot revoke a newer round.

Goal persistence still does not schedule a model turn by itself. A host driver
must establish whole-application quiescence, await its message-persistence
tail, preserve human FIFO across admission awaits, write durable turn evidence,
and recheck session, generation, activation, and abort ownership immediately
before provider creation. Restarting or merely resuming a conversation does
not recreate activation from `phase: active`; the operator or embedding host
must arm it explicitly. This keeps a durable state read from becoming hidden
work.
