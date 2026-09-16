---
'@namzu/sandbox': patch
---

Fix both the kubernetes/Firecracker guest agent (`agent/agent.cjs`) and the
container-tier HTTP worker (`worker/server.js`) reporting a cancelled
`exec()` as a clean, unaborted-looking success when the target process
ignores `SIGTERM` but happens to finish on its own before the cancel grace
window elapses. Both peers' `terminateAndConfirm` only escalated to
`SIGKILL` if the owned process group was still alive at the end of that
window, with nothing checking that the exit was actually caused by the
signal — so an ignoring process whose natural runtime was under the grace
period ran to completion untouched, in violation of
`SandboxExecOptions.signal`'s contract ("must terminate the owned process
... never silently ignore the signal and let the command run to
completion"). This is the same mechanism on both transports, found on the
guest agent first (issue #469's kind conformance run) and confirmed to
exist verbatim in the worker once looked for.

The default (previously `2000`ms on both) is now `250`ms for
`NAMZU_AGENT_CANCEL_GRACE_MS` (agent) and `NAMZU_SANDBOX_CANCEL_GRACE_MS`
(worker) — comfortably under the shared conformance suite's adversarial
fixture (a command that finishes on its own in ~400ms) while still enough
for a fast, well-behaved SIGTERM handler's cleanup. A deployment that
genuinely needs a longer window for cooperative shutdown sets either
variable explicitly; both were already, and remain, overridable. A new
regression test on each transport deliberately leaves its own grace
variable unset — the one thing every other suite on that transport
overrides — and fails against the old default, passes against the new one.

**Defect 2, found alongside the agent fix, is now MITIGATED for the
Kubernetes backend's shipped image, not merely documented:** in a real pod
the agent used to run as the container's PID 1 with no subreaper
(`packages/sandbox/k8s/entrypoint.sh` `exec`ed straight into it), so a
background job forked by a cancelled `sh -c` command (`... &`) reparented
to the agent on `SIGKILL` and was never reaped — Node's `child_process`
only `waitpid()`s the children it spawned itself — running that
cancellation out the full `RemoteExecutionController` cancel-confirm window
(8s by default) and tearing the sandbox down instead of confirming.
`k8s/entrypoint.sh` now execs into `tini` (installed in `k8s/Dockerfile`)
as the container's real PID 1 and subreaper, with the guest agent as its
child; `tini` reaps the orphan and forwards `SIGTERM` to the agent exactly
as before. **A host building its own image from `agent.cjs` directly rather
than from `k8s/Dockerfile` must still provide its own subreaper as PID 1**
— this fix lives in the shipped image, not in the agent itself, since
`agent.cjs` cannot know what pid it is. Root-caused with live evidence in
`research/k8s-sandbox/kind-e2e-results.md` ("Defect 2", `2026-09-16`) and
re-verified in-cluster against the new image in
`research/k8s-sandbox/abort-case-recheck-results.json`.

**Patch, not minor or major:** `agent/agent.cjs` and `worker/server.js` are
guest/worker files that run INSIDE a sandbox or container, never imported
by a consumer of the published `@namzu/sandbox` tarball (`npm pack
--dry-run` packs only `dist` and `src`); the k8s image's `Dockerfile` and
`entrypoint.sh` are likewise deployment artifacts, not the package's own
`exports`. Both defaults that changed are guest-/worker-internal timings
with no public type or exported symbol affected, and both changes narrow
when a cancellation escalates to `SIGKILL` and add a real subreaper —
strictly tightening what `SandboxExecOptions.signal`'s contract already
promised, never loosening it, so no caller-visible behavior a consumer
could have depended on gets worse.
