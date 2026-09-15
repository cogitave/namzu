---
type: Reference
title: Background jobs in the CLI
description: How a command started with run_in_background outlives its turn, how the model waits on or learns that it ended, what /jobs shows, and how a job runs inside the sandbox.
resource: packages/cli/src/tui/agent.ts
tags: [cli, jobs, shell]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# Background jobs in the CLI

# Starting one

The model passes `run_in_background: true` to `bash` for work that legitimately outlasts a tool call: a dev server, a watcher, a long build. The call returns the job's id at once and the turn goes on. The `job` tool reads a job's output (`action: read`, with the previous call's `next_offset` to see only what is new), lists them, or stops one. To find out whether a job has finished, use `wait_for_job` (below) rather than calling `job` with `action: read` in a loop — `job`'s own description says so.

# Waiting for one

`wait_for_job` blocks inside one tool call until a job ends, and returns its accumulated output — the shell-job counterpart to the coordinator's `wait_for_task`. It costs one call and no waiting turns, instead of a `job read` (or `job list`) sent on every turn until the job happens to be done.

The wait is bounded two ways, and either one gives up **without stopping the job**:

- a run bound (`timeout_ms`, default 5 minutes, capped at 1 hour) that counts elapsed time and is never refreshed;
- an idle bound (`idle_timeout_ms`, default 2 minutes) that counts time since the job's output last grew, and resets on every new byte — a job that is still producing output is never cut off for being slow, only for going quiet.

Either timeout is reported as a normal result naming which clock ran out, with the output read so far and a `next_offset` to resume from — the model can call `wait_for_job` again, or fall back to `job read`. The defaults come from `NAMZU_JOB_WAIT_TIMEOUT_MS` / `NAMZU_JOB_WAIT_IDLE_MS`, with `NAMZU_JOB_WAIT_MAX_MS` as the ceiling either call may request.

# Permissions

Reading, listing or waiting on a session's background jobs is read-only and skips
an extra approval by default, including in plan mode. Starting a command and
stopping a job retain their normal approval requirements. Ownership and sandbox
boundaries still apply; another session's job remains inaccessible.

To request review even for output observation, set `permissions: { job: ask }`
or `permissions: { wait_for_job: ask }` in the CLI configuration. Explicit ask
rules take priority over the read-only default; deny rules continue to block.
Auto mode and an intentional prior approval still follow the selected
permission policy.

# Learning that it ended

`wait_for_job` is the model asking; the notices below are the kernel telling it without being asked, for a job nothing is blocked on:

- **During a turn**, the kernel attaches a `[Background job update]` line to the model's next tool result — no polling — and emits `background_job_exited`; the transcript shows a `⚙` row.
- **At the end of a turn**, for a job the model awaited, the run suspends rather than settling over it; the same line arrives as a `runtime-context` message (`{ type: 'runtime-context', kind: 'job-exit' }`) when the wait releases. See *Waiting at the end of a turn* below.
- **Between turns**, the session hears the exit itself: the `⚙` row appears at once, and the next message to the model opens with the jobs that ended since its last turn.

Exactly one of the three announces any given exit. The first two are the kernel's, and each drains the notice as it delivers it, so an exit already attached to a tool result is not delivered again by the suspend. The third is the session's, and it only ever sees an exit that landed with no run open — the case the kernel is not there to hear.

None of them knows a `wait_for_job` call is already blocked on the same job: unlike the delegated-task inbox, which lets a blocking `wait_for_task` claim a completion so it is not also announced, nothing here suppresses the notice for a job `wait_for_job` is about to report on its own. A job that exits during a `wait_for_job` call can therefore surface twice — once as that call's own result, once as the `[Background job update]` line on the same or a later tool result. Redundant, not contradictory: both describe the same exit.

# Waiting at the end of a turn

A turn that ends without calling a tool leaves the `[Background job update]` line with nothing to ride on, so a run that stopped while a job was still going used to settle straight over it. That is precisely the moment the model has nothing left to do but wait — and a recorded run did exactly that, by hand, with a `sleep 30` between polls.

So the kernel suspends instead. When the model stops calling tools and a job it awaited is still running, the run waits — a real timer, no provider request, no tokens — for whichever comes first:

- **the job exits** → the notice is delivered and the model gets one more turn to use it;
- **the operator types** → the message is delivered and the model gets that turn instead; the job is untouched, because ending a wait is not ending the work;
- **the grace runs out** → the run settles and names the job on the run's `abandonedJobIds`, which is a statement, not a stop.

The grace is half of what the run has left before it must start finishing — the same grace a delegated task gets, since one wait covers both — under a ceiling of its own for the job half: **two minutes**, or `NAMZU_JOB_HOLD_MAX_MS`.

Both halves of that matter, because they bind in different configurations:

- **A run with a `timeoutMs`** takes the grace OUT of what is left rather than adding to it, so time a `wait_for_job` call already spent has shortened the hold by the same amount.
- **A run without one** — the CLI's default, no run deadline — has no remainder to halve, so the task grace would be its flat ceiling of an hour. For a delegated task that is sound, because an hour is also the longest the task may live. A background job has no such bound: `tail -f` outlives any ceiling. The two-minute job ceiling is what stands in for the missing deadline, so a `wait_for_job` that ran its hour out is followed by two more minutes at most, not by a second hour.

Two minutes because the hold is buying a turn in which to USE the exit, not watching the job: a job that stayed quiet through its `wait_for_job` bound is rarely two minutes from finishing, and letting the run end is not losing the news — with no run in flight the session announces the exit itself, which is the cheaper of the two places to hear it. Where a delegated task is outstanding as well, the run waits the task's grace, because that is how long it was waiting anyway. The iteration limit bounds all of it — a job that never exits cannot hold a run open past any of these.

**Awaiting is something the model says, never something the kernel infers.** Only a job `wait_for_job` named is awaited, and only for the rest of the run that named it. A dev server, a watcher, a `tail -f` — anything started with `run_in_background` and never waited on — holds nothing open, which is the whole point of having started it that way. There is no flag on `bash run_in_background` that changes this: the wait is the signal. The suspend also starts nothing and stops nothing; it only decides whether there is a turn left worth taking.

The intent lasts for the rest of the run, so `wait_for_job` on a process meant to keep running — a server the model only wanted a health check from — adds the job ceiling to every later settle point in that run. Look in on such a job with `job read`; wait on the ones that are supposed to end.

# Lifetime

A job is its **process group**, not its shell. A command that backgrounds its real work (`python3 -m http.server 8765 &`) returns from the shell at once; the job stays `running` while any process it started is alive, ends with the shell's exit code when the last one is gone, and a stop takes the survivors with it.

Jobs belong to the **session**, not the turn: a server started in one turn is still there in the next. They are stopped when the session closes (`/exit`, `Ctrl+D`, the process ending). `/jobs` lists every job started this session with its state — running for how long, exited with which code, stopped.

# Under a sandbox

A job runs inside the boundary. The sandbox starts the process itself — the local provider does, under the same bwrap or seatbelt confinement, mounts and environment the foreground command gets — and the registry only keeps it: output, lifetime, ownership, and a stop that reaches bwrap's inner reaper. The kernel never runs a job on the host to get around a sandbox: a sandbox that cannot start a detached process has no registry in its tool context, and `run_in_background` says which case it is in rather than blaming the host.
