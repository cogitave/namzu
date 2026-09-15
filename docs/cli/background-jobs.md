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

`wait_for_job` is the model asking; the two notices below are the kernel telling it without being asked, for a job nothing is blocked on:

- **During a turn**, the kernel attaches a `[Background job update]` line to the model's next tool result — no polling — and emits `background_job_exited`; the transcript shows a `⚙` row.
- **Between turns**, the session hears the exit itself: the `⚙` row appears at once, and the next message to the model opens with the jobs that ended since its last turn.

These two notices do not know a `wait_for_job` call is already blocked on the same job: unlike the delegated-task inbox, which lets a blocking `wait_for_task` claim a completion so it is not also announced, nothing here suppresses the notice for a job `wait_for_job` is about to report on its own. A job that exits during a `wait_for_job` call can therefore surface twice — once as that call's own result, once as the `[Background job update]` line on the same or a later tool result. Redundant, not contradictory: both describe the same exit.

# Lifetime

A job is its **process group**, not its shell. A command that backgrounds its real work (`python3 -m http.server 8765 &`) returns from the shell at once; the job stays `running` while any process it started is alive, ends with the shell's exit code when the last one is gone, and a stop takes the survivors with it.

Jobs belong to the **session**, not the turn: a server started in one turn is still there in the next. They are stopped when the session closes (`/exit`, `Ctrl+D`, the process ending). `/jobs` lists every job started this session with its state — running for how long, exited with which code, stopped.

# Under a sandbox

A job runs inside the boundary. The sandbox starts the process itself — the local provider does, under the same bwrap or seatbelt confinement, mounts and environment the foreground command gets — and the registry only keeps it: output, lifetime, ownership, and a stop that reaches bwrap's inner reaper. The kernel never runs a job on the host to get around a sandbox: a sandbox that cannot start a detached process has no registry in its tool context, and `run_in_background` says which case it is in rather than blaming the host.
