---
"@namzu/sdk": minor
"@namzu/cli": patch
---

A run now suspends for a background job the model said it was waiting on, instead of settling over it. When the model stops calling tools and a job named by `wait_for_job` is still running, the run waits — no provider request, no tokens — for the job's exit, an operator message, or the settle grace, whichever comes first. On an exit the model gets one more turn with the `[Background job update]` line in front of it; on neither, the run settles and names the job.

This is the same bounded, zero-token wait `CompletionInbox` already gave a delegated task, and it shares the delegated task's grace — half of what the run has left before it must start finishing — under a ceiling of its own: two minutes, or `NAMZU_JOB_HOLD_MAX_MS`. On a run with a `timeoutMs` the grace comes out of what is left rather than being added to it, so time a `wait_for_job` call already spent shortens the hold by the same amount. On a run WITHOUT one — no run deadline, which is what the CLI ships — there is no remainder to take a share of, and the task ceiling would be a flat hour; that hour is sound for a task, which cannot outlive it, and wrong for a job, which can run forever. The two-minute job ceiling is what bounds that case, so a `wait_for_job` that ran its own bound out is followed by two more minutes at most, not by a second hour. The iteration limit still bounds all of it, and the wait starts nothing and stops nothing.

**Wait-intent is explicit.** Only a job `wait_for_job` named is awaited, and only for the rest of the run that named it. A job nobody waited on — a dev server, a watcher — never holds a run open, and there is no opt-in flag on `bash run_in_background` that changes that.

**Why this is `minor` and not `major`.** The signal is new: no run that exists today can have an awaited job, because nothing before this could mark one. A host that never calls `wait_for_job` sees the loop it saw before, so no default changes and no existing behaviour is withdrawn.

Additive API:

- `Run.abandonedJobIds` — awaited jobs still running when the run ended, the job-side counterpart to `abandonedTaskIds`. Naming them is not stopping them: a run-owned job is still stopped by the run's own teardown, and one bound to the host's session keeps running.
- `RUNTIME_CONTEXT_MESSAGE_KINDS` gains `'job-exit'`, the provenance on the message that carries an exit delivered by the wait. Consumers that exhaustively switch on `RuntimeContextMessageKind` need a case for it.
- `BackgroundJobRegistryRef` gains an optional `markAwaited(id)`, and `bindOwner`'s options take an `onAwaited(id)` callback that backs it. Both are optional; a host that wires neither gets the previous behaviour, which is no hold.
- `NAMZU_JOB_HOLD_MAX_MS` sets the job ceiling above, in milliseconds, beside the `NAMZU_JOB_WAIT_*` knobs `wait_for_job` already reads. Unset is two minutes.
