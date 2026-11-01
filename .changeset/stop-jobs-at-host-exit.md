---
'@namzu/sdk': patch
---

A background job is now stopped when the host process ends by `process.exit` or an uncaught exception. Before, the job's command and anything it forked kept running as orphans with no way to stop them. A host killed by an unhandled signal still leaves them, as no listener runs then. Nothing to change in a host; a job that is meant to outlive the host should not be started as a background job.
