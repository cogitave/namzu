---
type: Reference
title: The monitor tool
description: The opt-in monitor tool, which turns each stdout line of a long-running command into an event the model reads while it keeps working, how lines are batched and rationed, how a monitor expires or is stopped, how events reach a turn, and when a turn stays open for one.
resource: packages/sdk/src/tools/builtins/monitor.ts
tags: [sdk, tools, jobs, monitor, background]
status: stable
generated: { by: claude-code/sonnet-5.5, at: 2026-10-21T00:00:00Z }
---

# The monitor tool

`MonitorTool` (`packages/sdk/src/tools/builtins/monitor.ts`, name `monitor`) starts a shell command as a background job and tells the model about each line the command prints to stdout, while the model keeps working. It answers "tell me when something happens inside this command" (a log line, a failed check, a status change). The other question, "tell me when this command finishes", is `bash` with `run_in_background` and [`wait_for_job`](bash-tool.md), and the tool's description sends the model there.

It is **not** in `getBuiltinTools()`. A host opts in with `getMonitorTools()`, because a watch is only worth starting where something delivers its events and wakes on them. It can be mounted deferred, as `code_analysis` is.

```ts sketch
import { getMonitorTools } from '@namzu/sdk'

const tools = getMonitorTools() // [MonitorTool]; mount it beside the builtins, deferred if you like
```

# Input

| Field | Meaning |
| --- | --- |
| `description` | 1 to 200 characters, shown with every event as `Monitor event: "<description>"`. It is what tells two watches apart. |
| `command` | The shell command. Each stdout line is an event. It must not need stdin. |
| `timeout_ms` | 1000 to 3,600,000, default 300,000. The host caps it (30 minutes, `MONITOR_TIMEOUT_CAP_MS`; a host may lower it with `QueryParams.monitorTimeoutCapMs`) and a larger value is lowered without an error. The result states the time actually granted. |

The result is `Monitor started (job <id>, expires in <duration> unless the command ends first; ...)`, with `data` of `{ jobId, monitor: true, timeoutMs }`. A monitor is a job of its owner: it counts toward the per-owner cap of eight, `job list` shows it as `monitor · <description>`, `job read` shows its output (stderr included, which is not an event), and `job kill` stops it with stop reason `stopped`.

# Permissions

A monitor runs a shell command, so the gate reads it the way it reads `bash`: `category: 'shell'`, `commandArgument: 'command'`, the same dialect, `permissions: ['shell_execute']`, never read-only, not concurrency-safe, destructive for the lines `bash` calls dangerous. It has no `sandboxEscapeArgument`: a watch that outlives one approved call never leaves the sandbox. A sandbox without `spawnDetached`, a host with no registry, a registry without `startMonitor`, `NAMZU_DISABLE_BACKGROUND_TASKS` and a dangerous command are all refused, with words that name the tool (`MONITOR_CANNOT_DETACH` for the sandbox case; `bash`'s own refusal talks about `run_in_background` and `timeout`, which are not this tool's).

# From lines to events

`createMonitorStream` (`runtime/jobs/monitor-stream.ts`) is pure: no process, no registry, an injectable clock and timer.

- Lines are split on `\n`, trimmed, and empty ones dropped. A line over 500 characters keeps its first 500 and ends `...(truncated)`. The partial line (no newline yet) keeps its tail past 1 MiB, and is emitted as a line only when the stream is drained at exit.
- The first buffered line arms **one** 200 ms timer; everything that arrives before it fires joins one batch. It is a fixed window, not a debounce. The batch is lines joined with `\n`, cut to 3000 characters plus `\n...(truncated)`.
- Batches pass a token bucket: capacity 10, one token back per 2000 ms, one token per **batch**.
  - An empty bucket drops the batch and counts it. The next batch that gets a token is preceded by `[N events suppressed — output rate too high. Consider stopping this monitor and starting it with a more selective command.]`.
  - If suppression began more than 30 s ago and another batch is dropped, the monitor is stopped with stop reason `too_much_output` and the notice `[Monitor stopped — too much output (N events suppressed over Ms). Restart it with a more selective command.]`.
  - The tracker resets only after a notice has been emitted and the last drop is more than 6 s old, so a source that is told and carries on still reaches the 30 s rule.

# Expiry and stopping

At its deadline the registry flushes the pending batch, emits `[Monitor expired after <duration> with N events delivered. Start it again if you still need the watch.]` (or `... with no events delivered. Start it again if you still need the watch — and widen the filter if silence was unexpected.]`), and stops the job with stop reason `expired`. The duration is `30m`, `5m`, `90s`: whole minutes as minutes, anything else in seconds. Every stop uses the registry's one `kill` (SIGTERM to the tree, then SIGKILL after the grace period); there is no second path. The expiry timer is unreferenced and cleared on exit.

On exit the stream is drained and its last batch is announced **before** the exit, so the final output is never lost to ordering.

`describeMonitorEnd(job, stats)` returns the status and summary every consumer uses for the end, so the model, the transcript and a single-shot run cannot disagree:

| Ended with | Status | Summary |
| --- | --- | --- |
| exit 0 and some stdout | `completed` | `Monitor "<d>" stream ended` |
| exit 0 and none | `completed` | `Monitor "<d>" ended without producing output (exit N)` |
| non-zero exit | `failed` | `Monitor "<d>" script failed (exit N)` |
| killed, expired or too much output | `killed` | `Monitor "<d>" stopped` |

# Events

`BackgroundJobRegistry.onMonitorEvent(listener)` delivers `MonitorEvent` objects: `{ id: "<jobId>:<seq>", jobId, owner, description, kind: 'output' | 'notice', text, at }`. A `notice` is the monitor speaking (suppression, stopping, expiry), an `output` is a batch of stdout lines. A listener that throws is ignored.

`bindOwner(...).startMonitor({ command, description, timeoutMs, workingDirectory? })` clamps the timeout to `monitorTimeoutCapMs` and returns `{ job, timeoutMs }`. `BackgroundJobRegistryRef.startMonitor` is optional, like `adopt`; a host that cannot deliver events leaves it out and the tool refuses.

# In a turn

`query()` subscribes for the turn's job owner. Each event is steered into a `monitorNotices` channel and rides out on the **next tool result**, appended as `[Monitor update]`, exactly as a job's exit does. Its text is a [system event](query.md) with `summary: Monitor event: "<description>"`, `more: job {"action":"kill","id":"<id>"} stops it`, and the lines inside the untrusted-content envelope: process output is never given to the model outside it. One notification is cut to 100,000 characters in the middle, with the cut stated. A monitor's end uses `describeMonitorEnd` in the same envelope.

The host hears the same thing as a `monitor_event` session event (`monitor.event` on the SSE wire; not on A2A) carrying `{ jobId, eventId, description, kind, text }`, and `background_job_exited` gains `monitor: { description, stopReason? }` for a monitor's end. `QueryParams.onMonitorEventsDelivered(eventIds)` is called only when the text has entered model context, mirroring `onJobNoticeDelivered`; a monitor's end is acknowledged through `onJobNoticeDelivered` with its job id. A host that wakes an idle session for events must not treat a `monitor_event` as delivered until one of these says so.

## Who stays awake

- **A session-owned monitor** (the host passed `backgroundJobOwner`: the terminal, ACP, Desktop) never holds the turn. The turn ends when the model has nothing to do, and the host wakes on the events.
- **A turn-owned monitor** (no `backgroundJobOwner`: a sub-agent, a plain SDK host) holds the turn open. Ending would start a watch and discard everything it finds, because nobody else is listening. `AwaitedJobs` keeps the monitor in its `monitors` set (`expectMonitor`, called through the bound registry's `onMonitorStarted`), `holdForOutstandingWork` races it with the task inbox, `waitForInbound` and `durableInbound`, and an event or the monitor's end wakes it. Waiting costs no tokens. The notices are then delivered as a `runtime-context` message of kind `job-exit` and the loop continues, so the model gets one turn per arrival. The bound is the monitor's own expiry (plus a second), capped by half the turn's remaining time before it must finish; `maxIterations` bounds the rest. Abort ends the hold, and the turn-release `killOwner` stops the monitor with the turn. An event already read on a tool result does not buy another turn.

# Constants

Exported from the SDK: `MONITOR_LINE_MAX_CHARS`, `MONITOR_BATCH_MAX_CHARS`, `MONITOR_BATCH_WINDOW_MS`, `MONITOR_PARTIAL_LINE_MAX_BYTES`, `MONITOR_BUCKET_CAPACITY`, `MONITOR_BUCKET_REFILL_MS`, `MONITOR_SUPPRESSION_LIMIT_MS`, `MONITOR_TIMEOUT_DEFAULT_MS`, `MONITOR_TIMEOUT_MIN_MS`, `MONITOR_TIMEOUT_MAX_MS`, `MONITOR_TIMEOUT_CAP_MS`, `MONITOR_NOTIFICATION_MAX_CHARS`.
