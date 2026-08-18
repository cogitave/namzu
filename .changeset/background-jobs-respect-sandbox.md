---
'@namzu/sdk': major
---

Refuse host background jobs when a run is sandboxed.

`bash` previously sent foreground commands through `Sandbox.exec`, but sent the same command directly to a host-spawning `BackgroundJobRegistry` when `run_in_background: true`. A caller that supplied both `sandboxProvider` and `backgroundJobs` therefore exposed both capabilities to every tool, and one input boolean moved work outside the configured boundary.

Sandboxed tool contexts no longer receive the host background-job reference. `bash run_in_background` reports that the two capabilities cannot be composed, while foreground `bash` continues through the sandbox and unsandboxed runs can continue to use the registry.

**What breaks:** a run configured with both `sandboxProvider` and `backgroundJobs` can no longer start a background job. Omit `sandboxProvider` only when host execution is the intended policy, run the command in the foreground to keep the sandbox boundary, or provide a future persistent-process backend that owns confinement as well as lifetime.
