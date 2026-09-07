---
"@namzu/sdk": major
"@namzu/cli": major
---

`maxDelegationWidth` now limits pending/active direct child sessions instead of
all historical children. Completed and failed history remains readable without
using a live slot. Hosts requiring a lifetime child quota must enforce it
separately; `capacityBehavior: 'reject'` still fails immediately when live slots
are full, but does not restore the former lifetime interpretation.

The CLI now queues excess agent tasks instead of failing them on width. The
SDK exposes opt-in `AgentManager` queue admission and a bounded pending queue.
Queued work receives a task ID before execution, rechecks host authority before
starting, and keeps cancellation and budget ownership with the parent. Queue
mode allocates tokens across available slots plus a parent share; CLI child
grants therefore change from geometric halves to that distribution. Total
configured token limits are unchanged.

Independent agent workflows now have separate navigation; phases remain inside
their own workflow. Agent launch approvals show type and capabilities, and
resource/policy stops visibly explain why a turn ended. Completed delegation
outputs identify the task and status before the child result, keeping IDs inside
that result separate from scheduler handles.
