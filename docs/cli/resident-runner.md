---
type: Reference
title: Managed resident runners
description: Opt-in background resident execution, local control, bounded authority and inspected recovery.
resource: packages/cli/src/integrations/resident/runner-launch.ts
tags: [cli, agents, continuity, processes, recovery]
status: draft
---

# Managed resident runners

A resident retains its identity, objectives and summaries on disk. A runner is
the process that executes those objectives. `namzu resident start` starts one
managed background process for a project and resident name. It survives the
launching command and terminal; ordinary chat can close independently. It does
not install a system service, start at login, or restart after machine reboot.

```bash
namzu resident add --trust "Read notes.md and prepare a checklist. Continue only while useful authorized work remains."
namzu resident start --trust --max-steps 3
namzu resident status
namzu resident stop
```

The existing `resident run` remains a foreground invocation that returns when
its idle policy says to return. Both commands use the same SDK host, CLI session
adapter and exclusive runner ownership. A second invocation cannot borrow work
or reset the budget while a recorded runner owns the resident.

## Authority and waiting

`start` requires positive finite `--max-steps`. That limit belongs to the entire
runner invocation and is preserved across all idle waits, scheduled continuations
and later additions to the agenda. A successful step consumes capacity; a failed
or interrupted step stops execution with its claim retained, rather than
replenishing the budget or automatically replaying it.

The default tool mode is `plan` (read-only). Provider/model/effort, tool permission,
iteration/token caps and verification gates use the existing
[resident run options](resident-work.md). Token and iteration limits are per
step; there is no cumulative lifetime credit ledger. Resolved configuration and
invocation flags are transferred in memory to the child, not stored as a second
configuration or credential file. Ordinary provider discovery still runs at
each admitted step; explicit provider/model flags pin that choice. Control-ready
does not promise that a later provider request will succeed.

`--tool-loading deferred` also reaches the background worker and creates a fresh
tool-availability snapshot for each admitted step. The default is `eager`.
See [optional tool schema loading](resident-work.md#optional-tool-schema-loading)
for the discovery behavior and its extra-round-trip tradeoff.

`--context-profile resident|interactive` is also transferred to the worker.
The default `resident` profile captures fresh continuation, memory and
environment for every admission while keeping stable work guidance separate.
Select `interactive` to retain the previous coding and plan-mode prompt;
neither profile changes permission enforcement or settlement. See
[resident step context](resident-work.md#context-for-a-resident-step).

An idle runner makes **zero model calls**. SDK `keepAlive` waits for scheduled
work or fresh agenda state; the CLI observes local controls every 250 ms.
`--max-idle-ms` defaults to 60,000 and must be positive for `start`: it bounds an
SDK idle timer, not the runner's total lifetime. A scheduled continuation can
therefore occur hours later while the process remains alive. Indefinite waiting
needs new evidence through `resident wake`, or a new authorized objective through
`resident add`. Finishing all objectives leaves the runner idle if capacity
remains. Reaching its step limit terminates it.

```bash
namzu resident add --trust "Prepare another short checklist from the new notes."
namzu resident wake <pursuit-id> "The missing input is now available."
```

These mutations can wake an already-authorized idle runner. They do not start a
process when no runner exists. Pause, unresolved work, execution failure,
cancellation and the step limit end the invocation. `resident resume` reopens
admission only; issue a new explicit `start` or `run` afterward.

## Status and stop

`resident status` reads the authoritative agenda and runner record, then asks
the recorded process for its current state through authenticated loopback TCP.
The endpoint exposes only status and stop, never tools or model execution.
Messages, connection count and deadlines are bounded. Authentication material
is held in private state and omitted from text/JSON output. An absent or invalid
reply means **unresponsive**, not dead.

Status shows the invocation UUID, mode, PID, original step limit and live
`starting`, `idle`, `working` or `stopping` state. `stepsStarted` counts callbacks
entered in this invocation; it does not claim their outputs were settled. The
agenda and per-claim attempt receipts remain the authority for actual results.
No PID is used as an unauthenticated kill target.

`stop` captures the current runner identity, durably pauses admission, requests
that exact runner to abort, and waits briefly for its drained receipt. It does
not retarget a successor that another controller starts during the operation.
The receipt is published only after the SDK invocation, session cleanup and
control endpoint finish. A callback that ignores cancellation keeps ownership
held. A reported cleanup failure also keeps ownership held; process exit alone
does not prove its subprocesses stopped. Unconfirmed drainage returns exit 1.

`pause` only acknowledges admission closure and an interruption request.
`stop` additionally checks drainage of the observed runner. Both preserve
interrupted pursuit claims for inspection. Concurrent controls can change
admission afterward, so inspect the current admission shown in the response.
SIGINT/SIGTERM request cleanup when sent to a runner directly; abrupt death can
leave uncertain effects and ownership.

## Startup, crashes and recovery

The launcher reserves immutable ownership before spawning the same installed
CLI's worker through the current Node executable. There are no shell commands,
ambient `namzu` executable lookup, inherited terminal pipes or persistent
parent-child IPC dependency. The child validates the bound project/cwd, installs
its control endpoint, publishes running ownership and acknowledges readiness.
It cannot admit a step before the parent's explicit handoff. A disconnect before
handoff aborts startup. A startup timeout does not authorize replacement.

The private owner log lives in the resident partition at
`NAMZU_HOME/projects/<projectId>/cli/residents/<agent>/runner/revisions/`.
Complete numbered records are published exclusively; old revisions are never
removed. Only the exact owner can publish its stopped receipt. An old delayed
completion cannot erase or overwrite a newer owner's reservation. The log is
not physically compacted. It is designed for trusted local filesystems.

After abrupt death, inspect processes and effects independently. Stop every old
executor before confirming recovery. Then use the exact runner UUID from status:

```bash
namzu resident pause
namzu resident release <runner-id> --executor-stopped
```

Release requires prior pause and refuses an owner that still answers its control
endpoint. The confirmation is the operator's assertion that all old executors
stopped and their effects were inspected. An unresponsive endpoint alone cannot
establish that assertion. `released` records are therefore distinct from
`stopped` drainage receipts. Release changes only runner ownership; an unresolved
pursuit still needs the existing exact-claim
[reconciliation procedure](resident-work.md#pause-wake-and-recovery). It never
replays a tool or clears the pursuit implicitly.

Stop/status/release remain available when normal configuration is malformed.
Start still requires trusted bound-directory resolution and valid execution
configuration. State corruption is refused; the CLI does not overwrite it or
guess a stale owner from a timestamp.

## Scope

This is local, opt-in hosting for one resident agenda. It does not install OS
supervision, deliver external messages, open a TUI resident dashboard, provide
full-transcript continuation, or automatically repair interrupted work. The
runner acts within explicitly supplied objectives; keeping it alive does not
turn a fixed fair agenda selector into self-directed learning or consciousness.

The process mechanics follow Node's documented
[detached child and stdio lifetime](https://nodejs.org/api/child_process.html#optionsdetached)
and [local networking](https://nodejs.org/api/net.html) behavior. SDK process tests
verify zero-call idle survival, later additions/wakes and one step limit across
them. CLI socket, process and command tests exercise exact-owner stop,
non-cooperative cleanup, crashes, stale release and parent exit.

The [2026-09-11 CLI smoke evidence](../../research/resident/results/2026-09-11-managed-cli-live.json)
records actual terminal invocations with Muse Spark low effort. One prescribed
objective settled a wait and then a completion without another user message;
its previous summary appeared in the second run's context. The same idle worker
later accepted a second objective and stopped at its original three-step limit.
A final-build empty-work runner stayed at zero callbacks, refused another start,
and acknowledged stop after drainage. All fixture processes were stopped.

The three model responses used 25,300 reported tokens, zero tool calls and no
project changes. About 8,300 input tokens per tiny step demonstrates remaining
context overhead, not an efficiency improvement. Cost accounting marked tokens
unpriced. The evidence identifies built files changed between the model smoke
and final zero-call lifecycle check; failure/recovery behavior is covered by
synthetic process tests. This test does not establish independent initiative.
