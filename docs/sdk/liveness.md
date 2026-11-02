---
type: Reference
title: Liveness of running work
description: The three facts the kernel keeps about a background job (where it is, when it last wrote, whether its process is still there), the one verdict derived from them (progressing, waiting, stalled, dead, finished), the thresholds, the line every status read prints, and the time carried by job and monitor notices.
resource: packages/sdk/src/runtime/jobs/liveness.ts
tags: [sdk, jobs, monitor, status, liveness]
status: stable
generated: { by: claude-code/sonnet-5.5, at: 2026-11-02T00:00:00Z }
---

# Liveness of running work

A host answering "how is it going" needs three facts about each running item, none of which it should guess: where the item is, when it last made progress, and whether it is still there. The kernel keeps them for background jobs and monitors, and `judgeLiveness` turns any item's three facts into one verdict. Hosts add the same verdict for the work they own (the CLI does it for agents and workflow runs, see [the outstanding-work note](../cli/delegated-work.md#the-outstanding-work-note)).

## The facts on a job

| Fact | Where it comes from |
| --- | --- |
| Where it is | `BackgroundJob.lastOutputLine`: the last non-empty output line, with control sequences removed, flattened and clipped to 160 characters. |
| When it last progressed | `BackgroundJob.lastOutputAt`: stamped on every write to stdout or stderr. Absent until the job has written; the start time stands in. |
| Whether it is alive | `BackgroundJobRegistry.isAlive(id)` (also on the ref `bindOwner` returns): asks the system whether the job's process group exists, not the record. A group that exists but is not ours to signal (EPERM) counts as there. A workflow run's last progress is derived from its agents' own times and events. One caveat: between the group ending and the record closing (the close handler polls every 250 ms) a recycled pid that leads a new group would read as alive. A job with no process of its own to probe (a WebSocket source, a sandboxed job, a platform without process groups) is alive exactly while the registry says it is running. |

## The verdict

`judgeLiveness(input, now, thresholds?)` is a pure function: the caller passes the clock and the probe's answer.

| Verdict | When |
| --- | --- |
| `finished` | A result or an end has arrived. Beats every other row. |
| `dead` | Not alive and no result: gone without one. |
| `waiting` | Alive, and either a reason is known (`waitingOn`, with `waitingSince`) or the item has been silent for `LIVENESS_QUIET_MS` (30 s) without reaching the stall bound. |
| `stalled` | Only a reason to look, not proof of trouble. Alive, no known reason to wait, silent for `LIVENESS_STALLED_MS` (2 minutes: the same number `wait_for_job` uses as its idle default, so there is one threshold to explain). |
| `progressing` | Alive and progress is newer than the quiet threshold. |

The result carries whole seconds of idle time and age, and `formatLivenessLine` prints one line, the same everywhere:

```text
job b3k9x2m1 "npm test" - progressing - last progress 4s ago - at: compiling
job b7q1d0aa "make all" - stalled - last progress 3m 20s ago
monitor bc40ffe2 "deploy log" - waiting on a free slot for 45s
job b0aa11cc "serve" - dead: gone without a result after 9s, last progress 8s ago
```

Free text (label, last line) is flattened to one line and clipped, and is data, not instructions.

## Where the kernel prints it

- `job` with `action: "list"` prints this line for each running job; an ended job keeps its status word and exit.
- `job` with `action: "read"` ends with `[job <id> is still running; last output 12s ago; next_offset N]`.
- `wait_for_job` gives up with `no new output for 134s (waited 135s)`: the real silence, not "a while". The idle default is the same `LIVENESS_STALLED_MS`.

## Time on notices

A frame the model reads later than it happened should say when. A monitor event and a monitor's end are `<system-event … at="2026-11-02T09:30:15.000Z">` (`SystemEvent.at`, rendered as an ISO attribute only when given), and a job's exit notice reads `Background job b3k9x2m1 (make) exited with code 0 at 2026-11-02T09:30:15.000Z.`

A task completion notification gains a `finished_at: <ISO time>` line after `duration_ms`.
