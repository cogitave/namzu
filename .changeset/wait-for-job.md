---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Add a `wait_for_job` builtin tool: it blocks on a background job's exit under a run-length bound and an idle bound that resets on new output, and returns the job's accumulated output in one call — the shell-job counterpart to the existing `wait_for_task`. Neither bound stops the job; a timeout reports which clock ran out and the output read so far, with a `next_offset` to resume from. Ships by default alongside `job` and `bash`, and refuses cleanly on a host with no background job registry.

`job`'s own description no longer instructs polling with `action: "read"` in a loop; it now points at `wait_for_job` instead. `read` and `list` are unchanged.

`BackgroundJobRegistry` gains a public `waitForExit(id, { signal })`, resolving immediately for a job that has already exited and honouring an abort signal. `BackgroundJobRegistryRef` (the tool-context surface) gains an optional `waitForExit` of the same shape — additive, so an existing host implementing this interface directly keeps working without it; `wait_for_job` refuses cleanly when it is absent.
