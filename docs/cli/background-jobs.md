---
type: Reference
title: Background jobs in the CLI
description: How a command started with run_in_background outlives its turn, how the model and the operator learn that it ended, what /jobs shows, and how a job runs inside the sandbox.
resource: packages/cli/src/tui/agent.ts
tags: [cli, jobs, shell]
status: stable
generated: { by: human:bahadirarda, at: 2026-09-02T00:00:00Z }
---

# Background jobs in the CLI

# Starting one

The model passes `run_in_background: true` to `bash` for work that legitimately outlasts a tool call: a dev server, a watcher, a long build. The call returns the job's id at once and the turn goes on. The `job` tool reads a job's output (`action: read`, with the previous call's `next_offset` to see only what is new), lists them, or stops one.

# Learning that it ended

- **During a turn**, the kernel attaches a `[Background job update]` line to the model's next tool result — no polling — and emits `background_job_exited`; the transcript shows a `⚙` row.
- **Between turns**, the session hears the exit itself: the `⚙` row appears at once, and the next message to the model opens with the jobs that ended since its last turn.

# Lifetime

A job is its **process group**, not its shell. A command that backgrounds its real work (`python3 -m http.server 8765 &`) returns from the shell at once; the job stays `running` while any process it started is alive, ends with the shell's exit code when the last one is gone, and a stop takes the survivors with it.

Jobs belong to the **session**, not the turn: a server started in one turn is still there in the next. They are stopped when the session closes (`/exit`, `Ctrl+D`, the process ending). `/jobs` lists every job started this session with its state — running for how long, exited with which code, stopped.

# Under a sandbox

A job runs inside the boundary. The sandbox starts the process itself — the local provider does, under the same bwrap or seatbelt confinement, mounts and environment the foreground command gets — and the registry only keeps it: output, lifetime, ownership, and a stop that reaches bwrap's inner reaper. The kernel never runs a job on the host to get around a sandbox: a sandbox that cannot start a detached process has no registry in its tool context, and `run_in_background` says which case it is in rather than blaming the host.
