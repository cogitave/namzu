---
'@namzu/sdk': minor
---

A background job is now stopped when the host process ends by `process.exit` or an uncaught exception. Before, the job's command and anything it forked kept running as orphans with no way to stop them. This changes what happens to a running job when the host exits: a host that relied on its jobs outliving it (a detached daemon or a scheduled-task host that starts a job and exits) now loses them. Start such work outside the job registry, for example with your own detached `spawn`. A host killed by an unhandled signal still leaves jobs behind, as no listener runs then. On Linux the exit path reads each process's environment once for all tracked jobs to find descendants that left the job's process group.
