---
"@namzu/sdk": patch
---

**Fixes a budget bug.** A run resumed from a checkpoint no longer gets a fresh allowance.

`RunPersistence.init()` overwrote the run record with zero usage, zero iterations and a new start time, and the resume path restored only messages — so token budgets, cost caps and iteration limits reset on every resume, and a run stopped at its cost cap could be resumed indefinitely, each time with a full new budget.

Accounting is now hydrated from the checkpoint before the run record is stamped. `tokenBudget`, `costLimitUsd` and `maxIterations` are lifetime limits of the logical run, accumulated across resumes: a run that has spent 90% of its budget resumes with 10% left.

`timeoutMs` now measures the run's **active execution time**, not calendar time. A run paused for three days and then resumed arrives with the budget it had when it stopped — the three days cost it nothing. Charging wall-clock time to a limit the agent cannot control would make every human pause a timeout.
