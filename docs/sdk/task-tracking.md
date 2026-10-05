---
type: Reference
title: Task tracking and execution
description: Existing planning tasks, delegated execution handles and resident pursuits, their scopes and the host wiring needed to expose them.
resource: packages/sdk/src/types/task/index.ts
tags: [sdk, tasks, agents, planning, hosts]
---

# Task tracking and execution

Namzu already has task tracking. Its planning list, delegated execution and
resident agenda describe different records. A host chooses which capabilities
to compose; displaying a task does not create a running worker.

| Record | Existing API and tools | What its state means |
| --- | --- | --- |
| Session planning task | `TaskStore`, `buildTaskTools`; `task_create`, `task_update`, `task_list` | Agent-maintained plan with subject, owner and dependency edges. |
| Delegated invocation | `AgentManager`, `TaskScheduler`; coordinator `create_task`, `agent_task_list`, `continue_task`, `cancel_task` | Actual admission, execution, cancellation and retained worker result. |
| Approved plan and steps | `PlanManager`; coordinator `approve_plan` and optional plan-step correlation | A host-approved plan and reported step outcomes. |
| Resident pursuit | `ResidentAgenda` and resident execution stores | A persistent resident's bounded pursuit, feedback and continuation state. |

Keep the IDs and scopes of these records separate. Correlation is explicit:
coordinator delegation can name a planning task or an approved plan step.
An invocation's ID is not an interchangeable planning-task ID, and a task's
`owner` label is not a Team membership or authorization grant.

## Enable planning tasks

Supply `taskStore` to `query()` or the host adapter that passes query options.
The query generates its planning tools only when this store is supplied.
Passing ordinary caller `toolsets` without a store does not enable them.
The runtime's task tools are deferred by default; a host can request active
definitions through `runtimeToolOverrides` for `task_create`, `task_update`
and `task_list`.

`InMemoryTaskStore` is useful for an ephemeral host. `DiskTaskStore` uses the
host's `SessionPaths` and exact session locator, storing each record under
`<session-id>/tasks/`. Tasks retain the turn that created them and survive later
turns and reopening that store. The disk store's `tenantId` configuration stamps
new records; it is not a general authorization boundary for arbitrary files or
custom stores. Hosts authorize their session and filter read projections by the
current session and tenant before exposing them.

`DiskTaskStore.list()` tolerates unreadable records and logs them. A host
replacing an authoritative view uses `listStrict()` instead: incomplete reads
reject, preserving the previous view rather than treating unreadable tasks as
deleted. A session without a task directory remains a valid empty list.

Deleting a task also removes its dependency edges from related tasks. Both
built-in stores publish each changed related record as `task.updated` before
the original `task.deleted` event. Creating a task with `blockedBy` publishes
its changed blocker rows before announcing the successfully created task.
A stream consumer can retain the current graph without waiting for a later
snapshot. Each record commits separately, so a later failure can leave partial
graph changes; notifications retain each confirmed write without claiming that
the whole operation succeeded.

The [CLI task context](../cli/task-context.md) reads this same store before
each interactive request and checkpoint resume. Pal computer-work turns use
the same durable planning store and bounded context. Offline conversational
admission retains its zero-tool contract: it does not grant computer or planning
tools. Casual conversation does not require creating tasks.

## Planning outcomes and dependencies

Planning statuses are `pending`, `in_progress`, `completed` and `failed`.
`task_update` accepts all four, as well as `deleted` to remove a record.
`task_list` reports failures separately through `stats.failed` and its human
presentation. A failed task is never counted as completed.

`isTerminalTaskStatus` treats completed and failed as terminal. A failed blocker
has stopped running, so a dependent task need not wait for a future status
change. Its failure still needs interpreting; removing the wait does not prove
the prerequisite succeeded or authorize dependent work.

`selectTaskContext(tasks, { turnId, turnStartedAt })` selects open tasks from
every turn plus tasks created or closed in the current turn. Earlier terminal
tasks remain in storage but do not crowd the next turn's planning context.
A resumed turn retains its original start time. CLI context uses this same
selector and terminal-status helper as `task_list`.

`task_list` returns that current-turn view, not the complete stored history.
Its `data.tasks` and `data.stats` count only visible rows. The model-facing
output names this scope and reports the number of earlier terminal records
retained but omitted. An empty filtered view says there are no open or
current-turn tasks; an empty store read says no tasks were found for the
session. Neither means earlier records were deleted. The human tool presenter
also qualifies its counts as a current-turn view, without displaying hidden
task IDs or history. Hosts needing the full durable list read their authorized
store, as the desktop snapshot does; they should not change task statuses just
to make historical completions appear in `task_list`.

## Delegated execution and reported outcomes

`agent_task_list` reports delegated invocations; `task_list` reports planning
items. A scheduler handle reaching `completed` means execution ended. Check
the actual stop reason and result: a limit or partial answer is not a successful
completion of the requested work. See [harness invariants](harness-invariants.md#delegated-lifecycle-versus-outcome)
and [delegation events](delegation-events.md).

When delegation has an explicit planning-task or plan-step binding, the
coordinator settles those original records for blocking and background work.
Completion delivery waits for that settlement; it cannot announce a completed
worker while leaving its bound task running. Plan correlation retains the
original plan, rather than writing into a replacement plan selected later.
Plan completion still requires reported outcomes for its steps; a worker's
receipt alone cannot verify the whole plan.

## Host views and restoration

The TUI's existing `/tasks` command and grouped task activity read planning
state. Background shell jobs use the separate job registry.

Desktop planning updates use the negotiated Namzu extension described in
[the agent client protocol](agent-client-protocol.md). `namzu/tasks/update`
replaces one task or removes it; `namzu/tasks/list` reads the authorized durable
list for cold opening and reconciliation. The standard `AcpSessionUpdate`
union remains unchanged. Old clients and hosts retain their previous protocol.
Only task ID, subject, status, dependency IDs and optional owner are projected;
descriptions, metadata, tenant IDs and filesystem paths are not copied.

Desktop retains live updates during a snapshot read and rejects a stale snapshot
from a replaced connection or session. Task rows show reported planning state
in Activity. The separate background-shell entry is labelled Shells.
Live notifications cover the current query. Later disk-only changes are read
when Activity opens, at turn settlement or on cold reconnect; there is no
unsolicited idle filesystem notification feed. Completion tracking remains
owned by the live runtime process, without reconstructing interrupted writes
or historical worker handles after process termination.
Neither view is an independent verifier of an artifact or a replacement for the
worker's actual result and evidence.

## Source map

- Planning contract: `packages/sdk/src/types/task/index.ts`.
- Persistent planning store: `packages/sdk/src/store/task/disk.ts`.
- Turn selection: `packages/sdk/src/store/task/context.ts`.
- Generated task tools: `packages/sdk/src/tools/task/` and `runtime/query/index.ts`.
- Delegation and planning correlation: `packages/sdk/src/tools/coordinator/`.
- Worker result delivery: `packages/sdk/src/scheduler/completion-inbox.ts`.
- CLI context and Pal composition: `packages/cli/src/integrations/sessions/task-context.ts` and `pals/agent-session.ts`.
- Desktop authorized reads: `packages/cli/src/commands/desktop-host.ts`.

The task architecture exists independently of a future Pal Team or organization
chart. Such features should compose these records and their existing scopes.
