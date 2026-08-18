---
uid: namzu.sdk.session-goals
title: Session-owned completion goals
description: Reference for durable completion goals in @namzu/sdk, including Session authority, exact revisions, lifecycle transitions, disk publication, and the boundary between goal state and automatic continuation.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-18T00:00:00Z
lastReviewed: 2026-08-18
resource: packages/sdk/src/store/goal/index.ts
tags: [sdk, sessions, goals, durability]
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
message.

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
tool.

Goal persistence does not itself schedule another model turn. Automatic
continuation and admitted-round accounting are a separate host driver because
they must arbitrate ordinary queued input, interruptions, session switches,
run budgets, and quiescence at the application boundary. Round counters and
caps are deliberately absent until that admission path can debit them
atomically. A host must not infer that an `active` record alone authorizes
hidden work.
