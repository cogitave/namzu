---
'@namzu/sdk': patch
---

Fix `LocalSandbox.exec()` leaving a cancelled or timed-out command's own children running.

Every sandboxed command runs as `sh -c "cmd"` (and, under the strongest local isolation tier, wrapped again in `unshare`), and on abort the local backend only ever signalled the outermost process Node itself spawned — never `cmd`, and never anything `cmd` (or the isolation wrapper) itself forked. A caller cancelling a run, or a run hitting its timeout, could leave the actual work running in the background indefinitely — and in the common case where the shell forks a real child rather than exec-replacing itself, the orphaned descendant kept the command's own stdio pipes open, so `exec()` itself never resolved at all.

The command is now spawned as the leader of its own process group (POSIX) and the whole group is signalled — SIGTERM immediately, SIGKILL after the existing `SANDBOX_KILL_GRACE_MS` grace period — instead of just the direct child pid. Windows has no process-group id to sign a kill with, so there the process tree is reaped with `taskkill /pid <pid> /t /f` instead, applied on both the immediate and the post-grace call since Windows has no soft-vs-forced signal distinction to grace between.

No public API change — `Sandbox.exec()`'s signature, options and result shape are all unchanged; this is a runtime behavior fix only.
