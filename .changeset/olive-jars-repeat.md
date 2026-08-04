---
'@namzu/sdk': minor
'@namzu/sandbox': patch
---

Three sandbox and delegation gaps, all of the same kind: something declared,
threaded through types, and never driven.

**`SandboxExecOptions.signal` now works — on the backend where it can.** The
option was declared, documented and exported, with a docstring stating that
without it "a Stop could only ever abandon the *wait* — the sandboxed process
kept running after the host believed the run had been cancelled". Every
backend dropped it, so that is exactly what happened. The local sandbox now
merges the caller's signal with the call's own deadline and hands the result to
`spawn`, so the child actually dies; a cancelled run is no longer reported as
`timedOut`, because a run someone stopped did not run too long, and telling the
model otherwise invites a retry with a bigger budget.

The remote backends still ignore it, now explicitly and with the reason in the
source. Their wire has no cancel op, so aborting the request would abandon the
wait while the command kept running — the original failure, wearing the
appearance of a fix. `SandboxExecOptions.signal` documents which backends
honour it.

**`ls` respects the sandbox.** It read the host through `node:fs` and named
`context.sandbox` nowhere, in the one builtin whose whole job is telling the
model what exists — so under a container or microVM backend the model's picture
of the filesystem was the host's. Its paths were host-relative too, while
`read`, `grep` and `glob` all resolve inside the sandbox, so an ls-to-read
handoff either failed or opened a different file than the one listed. `glob`
had the identical defect, was fixed, and its fix notes that "every sibling
builtin already remembers this branch"; this was the sibling that did not.

One behaviour difference worth knowing: inside a sandbox, directories are
derived from file paths, because `listFiles` reports files. An empty directory
is invisible there.

**The `Agent` tool's header described a design that no longer exists.** It told
readers to prefer `Agent` because `create_task` was a non-blocking trio driven
by notification callbacks. `create_task` blocks and returns the worker's output
as its own result, and `continue_task` / `cancel_task` are not registered at
all. The two tools are separated by how much of the coordinator surface they
bring, not by timing.
