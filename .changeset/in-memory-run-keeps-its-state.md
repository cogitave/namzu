---
"@namzu/sdk": major
---

A run held in memory now stays in memory: its checkpoints, its token ledger
and the children it delegates to. Before, such a run kept only its evidence in
memory and wrote `token-budget.json`, its checkpoints and their history log to
disk, one tree per run with nothing that removed it.

**What changes for you.**

- A `query()` (or agent) whose `runStore` is an `InMemoryRunStore` and which
  names no `pathBuilder` and no `checkpointStore` keeps its checkpoints and
  ledger in memory. They belong to the run the store is bound to, and are
  released when the same store is used for a different run id, just as its
  evidence is. A later call with the same store and the same run id can still
  resume. A run the store has moved past cannot, and fails with `Cannot restore
  a token budget from a missing checkpoint.` A host that relied on those disk
  files, or that returns to several runs, gives each run its own run store,
  passes a `checkpointStore`, or passes a `pathBuilder` to put everything back
  on disk.
- With no `tokenBudgetStore`, the ledger now lives where the checkpoints live.
  A host that passes an `InMemoryCheckpointStore` gets the ledger in that
  store's new `tokenBudgets` property instead of a `token-budget.json` on disk.
  A resume with the same checkpoint store is unaffected. A host that copies
  checkpoints into a new `InMemoryCheckpointStore` to resume must copy
  `tokenBudgets` too, or pass the same `tokenBudgetStore` to both runs.
  Otherwise the resume fails with `The token budget ledger required by this run
  is missing`. A checkpoint store of any other kind keeps the disk ledger.
- `BaseAgentConfig` takes `runStore` and `checkpointStore`, which `ReactiveAgent`
  and `SupervisorAgent` forward to `query()`. `checkpointStore` moved there from
  `ReactiveAgentConfig`, which still accepts it. A `SupervisorAgent` held in memory
  sets the new `AgentTaskContext.childStorage`, and `AgentManager` then gives each
  delegated child a fresh `InMemoryRunStore` (and the supervisor's
  `checkpointStore`, if it named one) unless the child's config names a
  `runStore` or `pathBuilder`. Such a child no longer writes under
  `defaultStateRoot()`. A host that pairs `query()` with its own
  `LocalTaskScheduler` sets `childStorage` on the context it builds.
- `InMemoryRunStore.writeRunMeta` no longer stores the run config's `logger`.
  An agent run on that store used to fail at its first write with
  `DataCloneError`, because every agent puts its logger in the run config.

`InMemoryTokenBudgetStore` is new and exported. It is a process-local
`TokenBudgetStore` that refuses the same regressions `DiskTokenBudgetStore`
refuses.
