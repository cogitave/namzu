---
"@namzu/sdk": major
---

A session held in memory stays in memory: its checkpoints, its token ledger
and the child sessions it delegates to. Before, such a session kept only its
evidence in memory and wrote its ledger and checkpoints to disk, one tree per
call with nothing that removed it.

**What changes for you.**

- A `query()` (or agent) whose `sessionLog` is an `InMemorySessionLog` and
  which names no `paths` and no `checkpointStore` keeps its checkpoints and
  ledger in memory, with the log. A later call with the same log can resume
  the same turn. A host that wants those files on disk passes `paths` (a
  `SessionPaths`) or its own `checkpointStore` and `tokenBudgetStore`.
- With no `tokenBudgetStore`, the ledger lives where the checkpoints live. A
  host that passes an `InMemorySessionCheckpointStore` and later copies its
  checkpoints into a new one to resume must pass the same
  `InMemorySessionTokenBudgetStore` to both calls; otherwise the resume fails
  because the ledger its checkpoint names is missing.
- `BaseAgentConfig` takes `sessionLog` and `checkpointStore`, which
  `ReactiveAgent` and `SupervisorAgent` forward to `query()`. A
  `SupervisorAgent` held in memory sets `AgentTaskContext.childStorage`
  (`ChildSessionStorage`), and `AgentManager` then gives each delegated child
  its own `InMemorySessionLog` (and the supervisor's `checkpointStore`, if it
  named one) unless the child's config names a `sessionLog` or `paths`. Such a
  child writes nothing under `NAMZU_HOME`. A host that pairs `query()` with its
  own `LocalTaskScheduler` sets `childStorage` on the context it builds.

`InMemorySessionTokenBudgetStore` is a process-local
`SessionTokenBudgetStore` that refuses the same regressions
`DiskSessionTokenBudgetStore` refuses.
