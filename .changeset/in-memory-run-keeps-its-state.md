---
"@namzu/sdk": major
---

A `query()` whose `runStore` is an `InMemoryRunStore` and which passes neither
a `pathBuilder` nor a `checkpointStore` no longer writes its token ledger (`token-budget.json`) or its
checkpoints and their history log to disk. They are held in memory by that
run store instance, like the run's evidence, and die with the process.
Before, such a run kept its evidence in memory and still left one
`projects/<id>/sessions/<id>/runs/<id>/` tree per run under the default state
root, with nothing that ever removed it.

**What changes for you.** A host that used an `InMemoryRunStore` and relied
on those disk checkpoints or that ledger (to resume from another process, or
to read them with `DiskCheckpointStore`) must now say where they go: pass a
`pathBuilder`, which puts both back on disk under the root it names, or pass
`checkpointStore` and `tokenBudgetStore` explicitly. A host that already
passes its own `checkpointStore` is unaffected: its ledger stays on disk, so a
resume from those checkpoints in a fresh process still finds it. Reusing one `InMemoryRunStore` instance across calls in
the same process resumes from the checkpoints an earlier call wrote.

`InMemoryTokenBudgetStore` is new and exported: a process-local
`TokenBudgetStore` that refuses the same regressions `DiskTokenBudgetStore`
refuses.
