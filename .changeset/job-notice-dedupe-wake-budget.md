---
'@namzu/sdk': minor
'@namzu/cli': minor
---

A background job whose exit a `wait_for_job` (or a `job` read of a stopped job) already returned is no longer announced a second time by a `[Background job update]` notice, and an idle session no longer wakes the model for it. A job-exit notice now carries the job's output inline when all of it is at most 2048 bytes (in an untrusted frame); larger output is still read with the `job` tool. New and opt-in: `WakeBudget` / `wakeBudgetFromEnv` and the `NAMZU_MAX_CONSECUTIVE_WAKES` setting cap how many automatic job wakes happen in a row (off unless set; only a person's message resets it), and `ToolContext.backgroundJobs` gains an optional `markCollected`. Nothing needs to change to keep the old behaviour except a host that parsed the notice text for the absence of output.
