---
"@namzu/sdk": minor
---

A background job's exit reaches the model without polling: the run subscribes to `BackgroundJobRegistry.onExit` and the exit rides out on the next tool result as a `[Background job update]` notice, and reaches the host as a `background_job_exited` event (`background_job.exited` on the SSE wire). `query({ backgroundJobOwner })` binds the run's jobs to an owner other than the run — a host's session, say — so a dev server started in one turn is still there in the next; the run then stops nothing at its end, and the host calls `killOwner` when its session closes.
