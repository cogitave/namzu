---
"@namzu/sdk": patch
---

Creating a task with `blockedBy` and deleting a task now emit `task.updated` for each existing task whose reciprocal dependency list actually changed, before `task.created` or `task.deleted`. Disk and in-memory task stores keep live event projections aligned with their dependency records, without announcing unchanged rows or the deleted task's self-edge as a surviving task. Repeated blocker references no longer add duplicate reciprocal edges in the in-memory store; supplied `blockedBy` references remain intact.

Confirmed disk neighbor writes are announced immediately, even when a later neighbor write, new-task record write, or target-file deletion fails. No created or deleted event is emitted for an unsuccessful creation or deletion, and already persisted changes remain observable.
