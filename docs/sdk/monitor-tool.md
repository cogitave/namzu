---
type: Reference
title: The monitor tool
description: The opt-in monitor tool, which turns each stdout line of a long-running command, or each text frame of a WebSocket, into an event the model reads while it keeps working, how lines are batched and rationed, how a monitor expires or is stopped, how events reach a turn, what a WebSocket source checks and refuses, and when a turn stays open for one.
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
| `command` | The shell command. Each stdout line is an event. It must not need stdin. Give this or `ws`, not both. |
| `ws` | `{ url, protocols? }`: watch a WebSocket instead of a command (see [WebSocket source](#websocket-source)). Exactly one of `command` and `ws` is required; a call with neither or both is refused. |
| `timeout_ms` | 1000 to 3,600,000, default 300,000. The host caps it (30 minutes, `MONITOR_TIMEOUT_CAP_MS`; a host may lower it with `QueryParams.monitorTimeoutCapMs`) and a larger value is lowered without an error. The result states the time actually granted. |

The result is `Monitor started (job <id>, expires in <duration> unless the command ends first; ...)`, with `data` of `{ jobId, monitor: true, timeoutMs }`. A monitor is a job of its owner: it counts toward the per-owner cap of eight, `job list` shows it as `monitor · <description>`, `job read` shows its output (stderr included, which is not an event), and `job kill` stops it with stop reason `stopped`.

# Permissions

A command monitor runs a shell command, so the gate reads it the way it reads `bash`: `category: 'shell'`, `commandArgument: 'command'`, the same dialect, `permissions: ['shell_execute']`, never read-only, not concurrency-safe, destructive for the lines `bash` calls dangerous. It has no `sandboxEscapeArgument`: a watch that outlives one approved call never leaves the sandbox. A sandbox without `spawnDetached`, a host with no registry, a registry without `startMonitor`, `NAMZU_DISABLE_BACKGROUND_TASKS` and a dangerous command are all refused, with words that name the tool (`MONITOR_CANNOT_DETACH` for the sandbox case; `bash`'s own refusal talks about `run_in_background` and `timeout`, which are not this tool's).

A `ws` call is a different kind of call and is treated as one: see [WebSocket source](#websocket-source) for how it is reviewed.

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

**Nothing follows a terminal notice.** The stream is closed the moment the expiry notice (or the too-much-output notice) is announced, and when a `job kill` stop is accepted for a monitor (after one last flush of the lines that were already complete). A command that ignores SIGTERM and keeps printing until the SIGKILL therefore cannot deliver more events after the model was told the watch was over. A remote stop (`terminateProcess`) closes the stream only once the stop is confirmed, so a failed stop leaves a monitor that still talks.

On exit the stream is drained and its last batch is announced **before** the exit, so the final output is never lost to ordering.

`describeMonitorEnd(job, stats)` returns the status and summary every consumer uses for the end, so the model, the transcript and a single-shot run cannot disagree:

| Ended with | Status | Summary |
| --- | --- | --- |
| exit 0 and some stdout | `completed` | `Monitor "<d>" stream ended` |
| exit 0 and none | `completed` | `Monitor "<d>" ended without producing output (exit N)` |
| non-zero exit | `failed` | `Monitor "<d>" script failed (exit N)` |
| killed, expired or too much output | `killed` | `Monitor "<d>" stopped` |
| a WebSocket the server closed (code 1000, 1001 or 1005) | `completed` | `Monitor "<d>" connection closed (<code>)` |
| a WebSocket the server closed with another code | `failed` | `Monitor "<d>" connection closed (<code>)` |
| a WebSocket that never opened (refused, rejected upgrade, handshake timeout) | `failed` | `Monitor "<d>" connection failed` |

# WebSocket source

Some services push their events and offer no command that prints them: a CI run's log stream, a change feed. `ws: { url, protocols? }` watches one. Everything after the source is the registry's and is shared with commands unchanged: the 200 ms batches, the token bucket, the 100,000-character cap, expiry, `job kill`, the retained output for `job read`, and the untrusted frame the model reads the events in. A frame is untrusted network content and reaches the model only that way.

**Input.** `url` must use `ws:` or `wss:`, be ASCII, carry no user name or password, no whitespace or control character and no fragment, and be at most 2048 characters. `protocols` are unique RFC 6455 tokens, at most 16. The model can set nothing else: no header, no address, no resolver.

**Frames.** A text frame is written as its text plus a newline on the job's stdout, so it splits into lines and joins the batch of whatever else arrives in the window. A binary frame becomes `[binary frame, N bytes]`. A frame over 1,048,576 bytes ends the watch with `[Dropped a frame larger than 1048576 bytes; closing]` (the socket library reports that a frame was too big and not how big, so the notice does not give N). Compression is not negotiated, because a compressed frame inflates past the size cap before it is measured, and a redirect is not followed, because it could lead to an address nobody checked.

**Lifecycle notices** are `notice` events, so the output limiter cannot drop them, and each ends the stream: `[WebSocket upgrade rejected: HTTP <status>]` when the server refuses the upgrade, `[WebSocket error: <message>]` when the connection fails before that is known, and `[WebSocket closed: <code> <reason>]` when it ends. A rejected upgrade is already terminal, so no closed notice follows it, and neither does one follow an error that ended the connection before it opened (a refused connection or a handshake timeout is one `[WebSocket error: ...]` notice, not an error then `closed: 1006`); after a close the job ends. The reason is server-written text, cut to one line of at most 123 characters, and it appears **only** in that notice (inside the untrusted frame) and in `job read`: never in the `summary:`, `source:` or `more:` line of an envelope, which sit outside the frame. The record's `closeReason` keeps it for a host that wants it. The same rule covers every server-chosen string (close reason, error message, HTTP status); the only caller-chosen text in metadata is the URL in `source:`, one line and capped at 200 characters. The frame's provenance says so: a WebSocket's output is `Text frames the WebSocket server sent`, and a WebSocket's notices are a notice from the monitor that `can quote text the server sent`, not the monitor's own words as for a command. `MonitorEvent.transport` carries `'websocket'` so a renderer can pick the wording. A stop the registry asks for (`job kill`, expiry, too much output) closes the socket with code 1000 and destroys it after one second if the server does not answer, and adds no notice of its own: the registry already said why.

**The job** is named `websocket <url>` (query string kept), has `transport: 'websocket'`, and records `closeCode` and `closeReason` when the server closed. The registry holds it through a `JobSource`, whose `child` is `JobChild`, the few members the registry reads, so a connection is held without pretending to be a `ChildProcess`; `JobProcess.child` is still a `ChildProcess`, and `StartJobParams.spawn` may return either. A source can send the registry notices through the `JobHost` its `spawn` receives. The registry starts it with `bindOwner(...).startWebSocketMonitor({ webSocket: { url, protocols?, addresses } })`, a method of its own beside `startMonitor` (command only, unchanged) and an optional member of `BackgroundJobRegistryRef`, so a host that implements only `startMonitor` refuses a `ws` call in plain words; the caller vets the addresses (the tool does).

## Where it may connect

The connection is opened by the **host** process, outside any sandbox, to an address the model chose. So:

- **Address check.** The host name is resolved with `dns.lookup({ all: true })` (an IP literal is taken as it is). The call is refused when the name does not resolve, resolves to nothing, or **any** answer is private, loopback, link-local (including `169.254.169.254`), unique-local, shared-address-space (`100.64/10`), benchmarking, site-local or multicast, or an IPv4-compatible, NAT64 or 6to4 spelling of any of those, by the same `isPrivateAddress` `web_fetch` uses (the full list is in [web tools](web-tools.md)). The URL parser has already turned `2130706433` and `0x7f.0.0.1` into `127.0.0.1`.
- **Pinning.** The socket is given a `lookup` that answers with the vetted addresses and nothing else, so it never asks DNS again. `web_fetch` documents a residual DNS-rebinding gap between its check and the platform `fetch`'s own resolution; here that gap is closed. TLS keeps SNI and the certificate check on the host name.
- **Sandbox.** Under a sandbox whose tier isolates the network (`isolationOf(environment).network`), the call is refused with a plain explanation unless the sandbox's live network policy lists the host (`Sandbox.networkPolicy.allowedHosts`, exact or `.domain`). A backend that enforces `setNetworkPolicy` should report it there; a backend that does not leaves it undefined, which means "not allowed" on an isolating tier. Without network isolation the call is allowed, subject to the address check and to review.
- **Web switch.** A call is refused unless the turn has a web capability (`ToolContext.web.fetch`), the same operator decision that turns `web_fetch` on. In the CLI that is `web.fetch: true`, which is off by default. The refusal says only that web access is off; `createMonitorTool({ webAccessHint })` appends the host's own sentence on how to turn it on (the CLI passes its config key), because the SDK cannot name a switch it does not own.
- **Test hooks.** `createMonitorTool({ webSocket: { resolve, allowPrivateAddresses } })` exists so a test can reach a server on this machine; they belong to whoever builds the tool and cannot be set by the model. `getMonitorTools()` with no argument returns the shared `MonitorTool`.

## How it is reviewed

`readOnly` is false, `category` stays `shell` and `commandArgument` stays `command`, so a call with no `command` gives a rule written for commands (`argument_pattern` on `command`) nothing to match: it cannot auto-allow a WebSocket call. Rules that do not read the argument (`allow_by_name`, the `shell` category the sandboxed-shell preset allows) would still let it through, so the tool declares `requiresApproval` for a `ws` call: a person is asked every time, an `allow` rule and `auto` mode do not outrank it, nothing remembered covers it, and with nobody to ask it is refused. That is stricter than "reviewed where the mode reviews non-read-only calls", on purpose: the connection leaves the boundary those modes rely on. A `deny` rule still wins. The command form is reviewed exactly as before; moving the whole tool to `category: 'network'` would have changed that.

`permissions` is now `['shell_execute', 'network_access']`. The gate routes by `category` and `requiresApproval`, not by this list, so declaring `network_access` changes no decision; it says what the tool may do. The approval shows `Monitor · <description> · WebSocket <url> (subprotocols: ...)`.

# Events

`BackgroundJobRegistry.onMonitorEvent(listener)` delivers `MonitorEvent` objects: `{ id: "<jobId>:<seq>", jobId, owner, description, kind: 'output' | 'notice', text, at }`. A `notice` is the monitor speaking (suppression, stopping, expiry), an `output` is a batch of stdout lines. A listener that throws is ignored.

`bindOwner(...).startMonitor({ command, description, timeoutMs, workingDirectory? })` and `startWebSocketMonitor({ webSocket, description, timeoutMs, workingDirectory? })` clamp the timeout to `monitorTimeoutCapMs` and returns `{ job, timeoutMs }`. `BackgroundJobRegistryRef.startMonitor` is optional, like `adopt`; a host that cannot deliver events leaves it out and the tool refuses.

# In a turn

`query()` subscribes for the turn's job owner. Each event's content is first shrunk to 20,000 characters in the middle (`MONITOR_EVENT_CONTENT_MAX_CHARS`; a batch is at most 3000, so this is a guard), then framed and steered into a `monitorNotices` channel and arrives as a user-role `[Monitor update]` message right after the **next tool batch**, exactly as a job's exit does; a tool result is never extended with it. Its text is a [system event](query.md) with `summary: Monitor event: "<description>"`, `more: job {"action":"kill","id":"<id>"} stops it`, and the lines inside the untrusted-content envelope: process output is never given to the model outside it. `description` and `command` go into the `summary:` and `source:` lines with every whitespace run collapsed to one space and cut to 200 characters (`…`), so a newline in the model's description cannot forge a metadata line and a long command is not repeated in full in every event. One notification is capped at 100,000 characters **by whole event**, never inside an envelope: the earliest and latest events that fit are kept and one plain line, `[N monitor events omitted — output exceeded the notification limit]`, stands between them. `onMonitorEvent` hands every listener every owner's events, so a consumer must filter on `event.owner`, as the turn does. A monitor's end uses `describeMonitorEnd` in the same envelope.

The host hears the same thing as a `monitor_event` session event (`monitor.event` on the SSE wire; not on A2A) carrying `{ jobId, eventId, description, kind, text }`, and `background_job_exited` gains `monitor: { description, stopReason? }` for a monitor's end. `QueryParams.onMonitorEventsDelivered(eventIds)` is called only when the text has entered model context, mirroring `onJobNoticeDelivered`; a monitor's end is acknowledged through `onJobNoticeDelivered` with its job id. `monitor_event` is **live only**: it is ephemeral like `tool_progress` and never written to the session log (the text the model read is already in the transcript, and a noisy watch would otherwise write tens of megabytes an hour a second time). `background_job_exited.monitor` stays durable and records how the watch ended. A host that wakes an idle session for events must not treat a `monitor_event` as delivered until one of these says so.

## Who stays awake

- **A session-owned monitor** (the host passed `backgroundJobOwner`: the terminal, ACP, Desktop) never holds the turn. The turn ends when the model has nothing to do, and the host wakes on the events.
- **A turn-owned monitor** (no `backgroundJobOwner`: a sub-agent, a plain SDK host) holds the turn open. Ending would start a watch and discard everything it finds, because nobody else is listening. `AwaitedJobs` keeps the monitor in its `monitors` set (`expectMonitor`, called through the bound registry's `onMonitorStarted`), `holdForOutstandingWork` races it with the task inbox, `waitForInbound` and `durableInbound`, and an event or the monitor's end wakes it. Waiting costs no tokens. The notices are then delivered as a `runtime-context` message of kind `job-exit` and the loop continues, so the model gets one turn per arrival. The bound is the monitor's own expiry (plus a second), capped by half the turn's remaining time before it must finish; `maxIterations` bounds the rest. Abort ends the hold, and the turn-release `killOwner` stops the monitor with the turn; a monitor still running then is logged (warning with job id and description) and reported as `background_job_exited` with `monitor.stopReason: 'stopped'`. An event already read on a tool result does not buy another turn.

# Constants

Exported from the SDK (the WebSocket limits, `WEBSOCKET_MAX_PAYLOAD_BYTES` and the rest, live in `runtime/jobs/websocket-source.ts`): `MONITOR_LINE_MAX_CHARS`, `MONITOR_BATCH_MAX_CHARS`, `MONITOR_BATCH_WINDOW_MS`, `MONITOR_PARTIAL_LINE_MAX_BYTES`, `MONITOR_BUCKET_CAPACITY`, `MONITOR_BUCKET_REFILL_MS`, `MONITOR_SUPPRESSION_LIMIT_MS`, `MONITOR_TIMEOUT_DEFAULT_MS`, `MONITOR_TIMEOUT_MIN_MS`, `MONITOR_TIMEOUT_MAX_MS`, `MONITOR_TIMEOUT_CAP_MS`, `MONITOR_NOTIFICATION_MAX_CHARS`, `MONITOR_EVENT_CONTENT_MAX_CHARS`.
