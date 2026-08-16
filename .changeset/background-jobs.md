---
'@namzu/sdk': minor
---

An owner-scoped background job registry, and a real background mode for `bash`.

`bash`'s schema used to end with "start it in the background and poll, rather than holding the turn open". That sentence was removed rather than honoured, because there was nothing to poll with — and because the shell cannot be trusted to background under the sandbox. On the `linux-namespace` isolation tier the wrapping `sh` is PID 1 of a fresh PID namespace; the kernel destroys a PID namespace when its init exits, so `sh -c "long-thing & echo go"` returns in milliseconds looking like it worked with the work already dead, on the successful path.

So the kernel holds the process itself. New: `BackgroundJobRegistry`, `bash`'s `run_in_background`, and a `job` tool that reads, lists and stops what it starts. Both ship in the default builtin set — an id with nothing that reads it is the same unbacked suggestion.

Every bound refuses rather than adjusting: the per-owner cap names the limit, and `bash` refuses `run_in_background` outright when the host has provided no registry rather than falling back to `cmd &`. Output retention drops the oldest bytes and **states how many**, because a job whose tail vanished quietly reads as a complete result that happens to be short.

Ownership is structural, not a check: the executor binds the registry to the run's id before a tool ever sees it, so there is no argument a tool could pass to reach another run's jobs. `query` kills the run's jobs in its `finally`, on the failed path too — a job that outlives its run is an orphan with nothing left that can name it.

`killTree` moves from `sandbox/provider/local.ts` to `process/kill-tree.ts`, unchanged, so both callers share one implementation.

Hosts opt in by passing `backgroundJobs` to `query`. Without it, nothing changes.
