---
"@namzu/sdk": patch
---

The kill helpers (`killTree`, `killTrees`, the tag scan, the host-exit sweep and the job registry's liveness probe) now refuse a pid that is not an integer above 1, or is the host's own. They used to pass a recorded pid straight to `process.kill(-pid)`, and a pid of 1 or 0 makes that call signal every process of the user or the caller's own group, so a job recorded with a placeholder pid could take the host down when it exited. A refused pid is treated as a process that is already gone and does not throw. Nothing to do: real jobs have pids above 1 and are stopped as before.
