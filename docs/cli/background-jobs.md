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

# A job that cannot start

A job and a foreground `bash` call start through the same function, `spawnHostShell` (`packages/sdk/src/tools/command-shell.ts`), so they cannot disagree about the shell. On Windows that is `cmd.exe /d /s /c` run under UTF-8: an outer cmd switches the console to code page 65001 and starts the real cmd, with the command carried in the environment so that letters the OEM page lacks (`ğ`, `ş` on CP850) are not flattened to `g` and `s` before the command runs; quoting, `%`, `&`, `|`, redirection and the exit code behave as in a plain `cmd /c`. `windowsHide` is set and no `detached` (that flag opens a console window there); elsewhere it is `<shell> -c`, in its own process group.

When the process cannot be created at all (no such shell, a missing working directory, which is named as such rather than as a missing `cmd.exe`), `bash` with `run_in_background` answers with an error that begins "Could not start the command:" instead of "Started background job". Should a job's start fail later, the registry records `error` on it and writes the same sentence to the job's stderr, `job read` and `wait_for_job` report the status as `failed to start: <reason>`, and no `exitCode` is invented. Output a Windows console wrote in its OEM code page (850, 857 and so on) is decoded in that page; output that is valid UTF-8 stays UTF-8.

On Windows a command's descendants that detach from the shell are not tracked after the shell exits; `taskkill /T` stops the tree while it is still linked.

# Watching and managing shells in the TUI

While a shell job runs, a line below the composer footer shows the number of running shells and points to `/jobs`. The line stays visible after the model's reply and updates when a job starts or ends, including during a turn. It does not take the Down key from the delegated-agent panel.

`/jobs` opens a session-scoped list of running and finished shell jobs. Move with Up/Down and press Enter for a job's status, command and retained output. The detail view follows new output while the job runs; Up/Down or Page Up/Page Down scroll, `g` goes to the oldest retained output, and `G` returns to the live tail. Press `x` on a running job in either view to stop it, Esc to return to the list or composer, and `q` to close the view. While a stop is pending, the stop hint disappears until that action settles. A stop is the operator's direct action on that session's process group; it does not ask the model to call a tool.

The output view is bounded and shows when earlier bytes were dropped by the job buffer or omitted from the screen. Terminal control characters are displayed as text, so job output cannot move the cursor or alter the view. `/jobs list` prints a plain text summary into the transcript when that is more useful than opening the view.

An exit that arrives while no model turn is open appears in the transcript and is included in the next request as an observation. Its command and status are request context, not system instructions. Once the kernel acknowledges an exit, the CLI does not announce it again.

# Waiting for one

By default, `wait_for_job` blocks inside one tool call until a job ends, and returns its bounded output — the shell-job counterpart to the coordinator's `wait_for_task`. It costs one call and no waiting turns, instead of a `job read` (or `job list`) sent on every turn until the job happens to be done.

The wait is bounded two ways, and either one gives up **without stopping the job**:

- a total bound (`timeout_ms`, default 5 minutes, capped at 1 hour) that counts elapsed time and is never refreshed;
- an idle bound (`idle_timeout_ms`, default 2 minutes) that counts time since the job's output last grew, and resets on every new byte — a job that is still producing output is never cut off for being slow, only for going quiet.

Either timeout is a successful observation, with `data.timedOut` naming `idle` or `wall`; it does not mean the job failed. The result includes the output read so far and an absolute UTF-8 byte `next_offset`. Pass that value as `from_offset` to the next `wait_for_job`, or to `job read`, to receive only later bytes. The waiter keeps at most the last 32 KiB of output in a result and names any earlier bytes it omitted. It separately names bytes the job registry has already dropped from its retained output. A cursor after omitted bytes remains usable for later output; the notice makes the gap explicit. The defaults come from `NAMZU_JOB_WAIT_TIMEOUT_MS` / `NAMZU_JOB_WAIT_IDLE_MS`, with `NAMZU_JOB_WAIT_MAX_MS` as the ceiling either call may request.

# Waiting for output

For a server that should stay running, use one condition wait:
`wait_for_job({ id: "job_1", output_contains: "Server ready", output_stream: "stdout" })`.
The exact literal is limited to 4096 UTF-8 bytes. `output_stream` defaults to
`either`; stdout and stderr are searched separately, including across chunks.
`from_offset` excludes earlier bytes and cannot be ahead of the produced output.

The call reports `matched`, `exited`, `stopped`, `timeout` or `aborted` in
`data.outcome`, with the job's actual status and cursor. A marker proves only
that text was observed; check HTTP health separately if needed. Wall and idle
bounds apply, but this observation never stops the process or expresses intent
to wait until exit. The parent turn can finish while the server stays running.
Unavailable history, unsearched channel history and omitted result bytes are
reported explicitly. A missing marker cannot prove it never appeared in lost
output. The live tool row says “Wait for job output”; `/jobs` continues to own
inspection and stopping. Hosts without output observation refuse this mode
instead of silently waiting for exit.

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

`wait_for_job` is the model asking; the notices below tell it without being asked, for a job nothing is blocked on:

- **During a turn**, the kernel attaches a `[Background job update]` line to the model's next tool result — no polling — and emits `background_job_exited`. The session listener shows a job row marked `J` as soon as the exit occurs.
- **At the end of a turn**, for a job the model awaited, the turn suspends rather than settling over it; the same line arrives as a `runtime-context` message (`{ type: 'runtime-context', kind: 'job-exit' }`) when the wait releases. See *Waiting at the end of a turn* below.
- **On the way out**, for an awaited job whose exit lands after that hold's grace has already run out — so the job was about to be named abandoned — but before the turn finishes settling, `deliverArrivedJobExits` still catches it: the same `runtime-context` message reaches `Turn.messages` instead of the job landing on `abandonedJobIds`.
- **Between turns, or after the turn's last delivery point**, the session hears the exit itself: the `J` job row appears at once, and the next message to the model opens with the jobs that ended since its last turn.

The session keeps each exit until the kernel acknowledges that its notice entered a tool result or recorded `job-exit` context, or a later completed turn carries it in its opening context. An exit after the last tool result may still occur before the turn settles; that exit is carried to the next turn. An early failed or aborted send does not consume a pending exit. The transcript shows one `J` row per exit, whether the kernel also emits its event or the session first observes the process closing. The exception below is about what the model reads, not duplicate transcript rows.

If the process cannot start, its job still finishes and announces one exit when the child closes. It has no process exit code: the spawn error is not a command's exit status. An error from a process that already started does not by itself end the job; the registry waits for that process to close.

None of them knows a `wait_for_job` call is already blocked on the same job: unlike the delegated-task inbox, which lets a blocking `wait_for_task` claim a completion so it is not also announced, nothing here suppresses the notice for a job `wait_for_job` is about to report on its own. A job that exits during a `wait_for_job` call can therefore surface twice — once as that call's own result, once as the `[Background job update]` line on the same or a later tool result. Redundant, not contradictory: both describe the same exit.

# Waiting at the end of a turn

A turn that ends without calling a tool leaves the `[Background job update]` line with nothing to ride on, so a turn that stopped while a job was still going used to settle straight over it. That is precisely the moment the model has nothing left to do but wait — and a recorded session did exactly that, by hand, with a `sleep 30` between polls.

So the kernel suspends instead. When the model stops calling tools and a job it awaited is still running, the turn waits — a real timer, no provider request, no tokens — for whichever comes first:

- **the job exits** → the notice is delivered and the model gets one more turn to use it;
- **the operator types** → the message is delivered and the model gets that turn instead; the job is untouched, because ending a wait is not ending the work;
- **the grace runs out** → the turn settles and names the job on the turn's `abandonedJobIds`, which is a statement, not a stop.

A job that ends in the moment between the last of those and the turn settling is delivered on the way out, as the same `runtime-context` message on `Turn.messages`, and is not named on `abandonedJobIds` — it finished, so claiming the turn walked away from it would be false. The kernel acknowledges that delivery to the session; an exit after the last delivery point remains pending for the next turn.

The grace is half of what the turn has left before it must start finishing — the same grace a delegated task gets, since one wait covers both — under a ceiling of its own for the job half: **two minutes**, or `NAMZU_JOB_HOLD_MAX_MS`.

Both halves of that matter, because they bind in different configurations:

- **A turn with a `timeoutMs`** takes the grace OUT of what is left rather than adding to it, so time a `wait_for_job` call already spent has shortened the hold by the same amount.
- **A turn without one** — the CLI's default, no turn deadline — has no remainder to halve, so the task grace would be its flat ceiling of an hour. For a delegated task that is sound, because an hour is also the longest the task may live. A background job has no such bound: `tail -f` outlives any ceiling. The two-minute job ceiling is what stands in for the missing deadline, so a `wait_for_job` that ran its hour out is followed by two more minutes at most, not by a second hour.

Two minutes because the hold is buying a turn in which to USE the exit, not watching the job: a job that stayed quiet through its `wait_for_job` bound is rarely two minutes from finishing, and letting the turn end is not losing the news — with no turn in flight the session announces the exit itself, which is the cheaper of the two places to hear it. Where a delegated task is outstanding as well, the turn waits the task's grace, because that is how long it was waiting anyway. The iteration limit bounds all of it — a job that never exits cannot hold a turn open past any of these.

**Awaiting is something the model says, never something the kernel infers.** Only an exit wait (`wait_for_job` without `output_contains`) marks a job awaited, and only for the rest of the turn that named it. A dev server, a watcher, a `tail -f` — anything started with `run_in_background` and never awaited for exit — holds nothing open, which is the whole point of having started it that way. There is no flag on `bash run_in_background` that changes this: the exit wait is the signal. The suspend also starts nothing and stops nothing; it only decides whether there is a turn left worth taking.

The intent lasts for the rest of the turn, so an exit wait on a process meant to keep running adds the job ceiling to every later settle point in that turn. Observe a server's marker with `output_contains` or inspect it with `job read`; use the default exit wait for work that should end.

# Lifetime

A job is its **process group**, not its shell. A command that backgrounds its real work (`python3 -m http.server 8765 &`) returns from the shell at once; the job stays `running` while any process it started is alive, ends with the shell's exit code when the last one is gone, and a stop takes the survivors with it.

Jobs belong to the **session**, not the turn: a server started in one turn is still there in the next. They are stopped when the session closes (`/exit`, `Ctrl+D`, the process ending). The `/jobs` view and `/jobs list` show every job started this session with its state — running for how long, exited with which code, stopped.

Here, session means the live CLI agent session. `/new` and `/resume` change the conversation inside it; they do not stop or reassign its shell jobs. The same `/jobs` list remains available until the CLI agent session closes. A separate Namzu process has its own job registry and cannot address these jobs.

# Under a sandbox

A job runs inside the boundary. The sandbox starts the process itself — the local provider does, under the same bwrap or seatbelt confinement, mounts and environment the foreground command gets — and the registry only keeps it: output, lifetime, ownership, and a stop that reaches bwrap's inner reaper. The kernel never runs a job on the host to get around a sandbox: a sandbox that cannot start a detached process has no registry in its tool context, and `run_in_background` says which case it is in rather than blaming the host.

`SandboxDetachedProcess` and the registry's `JobProcess` may also implement
`terminate(signal?): Promise<void>` for a remote boundary. The existing
`kill(signal): void` behavior remains available. When confirmed termination is
present, the registry waits for its promise and the wrapper's close before
announcing `killed` or `exited`. A failed confirmation rejects the stop call,
retains the job as `running`, and exposes optional `recoveryRequired: true` and
`stopError` on its `BackgroundJob` record. The diagnostic excludes raw transport
errors. The job retains ownership and capacity, cannot be forgotten, and can be
stopped again after recovery. Closing the host wrapper alone does not prove a
guest process tree ended.
