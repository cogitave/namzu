---
type: Reference
title: Resident work in the CLI
description: Explicit foreground execution of durable pursuits, project-bound state, pause observation and inspected recovery.
resource: packages/cli/src/commands/resident.ts
tags: [cli, agents, continuity, recovery]
status: draft
---

# Resident work in the CLI

`namzu resident` is the first CLI host for the SDK's
[resident experiment](../sdk/resident-agents.md). It retains authorized work
between processes and can take successive steps without another user message.
`run` executes in the foreground while explicitly invoked; `start` launches an
opt-in [managed background runner](resident-runner.md). Neither installs an OS
service, starts when ordinary chat opens, or sends proactive external messages.

## Start and inspect work

```bash
namzu resident add --trust "Read notes.md and prepare a short checklist. Continue with a follow-up step only if useful work remains."
namzu resident run --trust --max-steps 2
namzu resident status
```

`add` saves an objective without calling a model. `run` requires a positive finite
`--max-steps` for that invocation. The default tool permission mode is `plan`
(read-only); an explicit `--permission-mode` selects another existing CLI mode.
Configured deny rules still apply. `--trust` accepts the bound folder for this
invocation, independently of tool permissions; existing folder trust also works.

`run` uses the existing CLI `AgentSession`, including provider discovery,
credentials, tool rules, sandbox, project instructions, MCP, plugins, hooks,
memory, compaction and configured telemetry. It accepts the existing
`--provider`, `--model`, `--effort`, `--skills`, `--max-iterations`, `--token-budget`,
`--gate` and `--gate-retries` options. Gate commands are explicitly supplied host
verification commands; the tool permission mode does not sandbox those commands.

### Optional tool schema loading

`run` and `start` accept `--tool-loading eager|deferred`, default `eager`.
`deferred` keeps reading, file search, editing, shell/job and available web tools
ready, but loads optional schemas such as delegation, task management and memory
through `search_tools` when requested. Each step owns a fresh SDK
[registry fork](../sdk/tool-discovery.md); discovery in one step cannot activate
another step's tools. Newly loaded tools still pass the same permission rules,
plan restrictions, sandbox and execution gates. Provider-native web search is
unchanged. This option reduces initial schema context; discovery adds a model
round trip when an optional tool is needed.

```bash
namzu resident run --trust --max-steps 2 --tool-loading deferred
```

Project instructions, CLI working guidance, environment, memory recall and the
resident continuation summary remain in context. This is not a compact prompt
profile or an authorization change. The option belongs to the invocation, is
not saved by `add`, and does not change ordinary interactive chat. Internally,
`AgentSessionOptions.toolLoading` applies to fresh sends. Checkpoint resume uses
the existing session registry; the fork's activation snapshot is not persisted
or restored. Resident execution refuses checkpoint resume and retains interrupted
claims for inspection instead of replaying them.

In the [2026-09-11 synthetic CLI comparison](../../research/resident/tool-loading.md),
two small tasks used about 29% fewer reported input tokens with deferred loading.
Both completed under both modes; one deferred run used the detached worker.
These tasks needed no optional tool, so the result does not measure discovery's
extra round trip or establish a general performance gain.

Iteration and token limits apply **per SDK step**, not cumulatively across a
resident's lifetime. `--max-steps` bounds the number of admitted steps. Provider
failures and interrupted steps can consume tokens without settling a step.
No separate lifetime credit ledger is implemented here.

`--max-idle-ms` bounds a single idle wait, default 60,000. A later scheduled wake
outside that window returns control to the shell. An indefinite wait, completed
agenda or paused agenda makes no model call. While running, local storage checks
observe operator controls; these are not model heartbeat calls.

Use `--cwd <path>` to select a project and `--agent <name>` to select a resident
within it. The default name is `default`; names contain 1–64 lowercase letters,
digits, underscores or hyphens and start with a letter or digit. These are
operator names, not another family of generated entity IDs.

## Directory and state ownership

Residents reuse the installation tenant and the CLI's canonical
[Project binding](project-state.md). The first `add` saves its canonical execution
directory. Opening a subdirectory of the same checkout selects the same resident
and still executes in the saved directory. A missing directory, changed canonical
target or mismatched Project refuses execution; it does not silently relocate work.

Bindings and attempt receipts live below
`NAMZU_HOME/projects/<projectId>/cli/residents/<agent>/`, or the equivalent
`~/.namzu` path. The SDK agenda uses its existing tenant/key layout within that
resident state partition. Private directories protect generated state. Separate
Projects, worktrees and agent names have separate agendas.

`status` is read-only: it does not mint an identity, create a Project, initialize
a resident or construct a provider. Omitting the action means status, including
`namzu resident --cwd <path>`. Status/control/help remain usable with malformed
global or project configuration. `run` resolves configuration only after trusting
the saved execution directory; malformed configuration then refuses the run.

Text output shows objectives, summaries, phases and exact pursuit/claim IDs.
`namzu --format json resident status` exposes the structured agenda as well.
Keep the IDs intact when supplying a pursuit or claim to a control command.

## Continuation and decisions

Each admitted step uses a fresh isolated CLI session. Its context receives the
immutable objective, identity, last saved summary, wake reason and an approved
[learning snapshot](../sdk/resident-learning.md) bound to the admission revision.
Learning projection has a 12,000-character cap and selects currently active
host-approved skills. Oversized entries are reported as omitted. This is summary
continuation, not a resumed chat transcript or restored in-flight tool process.

The model proposes a final JSON decision: `complete`, `blocked` or `wait`, with
a nonempty summary of at most 8,000 characters. A wait names `wakeAfterMs: null`
for indefinite rest or an integer delay from zero to 86,400,000. A numeric delay
below 1,000 ms becomes 1,000 ms to leave time for durable settlement.
The existing SDK answer-review loop validates the decision and any configured
command gates before acceptance. Streaming commentary is never treated as a
decision. Only a settled `end_turn` result with a valid decision can settle the
resident claim, after session resources have drained.

`complete` is the model's reported disposition under the host's verification
policy, not independent proof that an objective succeeded. Configure relevant
gates when the task has executable acceptance criteria.

Each attempted claim gets `attempts/<claimId>/start.json` linking it to the actual
Session/Run IDs, cwd and provider/model. `finish.json` records the callback's
outcome, decision, reported usage, errors and `cleanup: confirmed|unconfirmed`.
Failed session construction or cleanup retains managed runner ownership because
resource drainage could not be established. These receipts omit raw provider
history, tool inputs and opaque reasoning blocks. A successful finish receipt
does not itself establish agenda settlement; consult the authoritative agenda.
Receipts and immutable revision history are not physically compacted.

## Pause, wake and recovery

```bash
namzu resident pause
namzu resident status
namzu resident resume
namzu resident wake <pursuit-id> "The missing input is now available."
namzu resident run --trust --max-steps 2
```

`pause` durably closes admission and increments a pause generation. Active CLI
runners check it locally (every 250 ms by default and around admission), abort
their callback signals and await cleanup. A quick `pause` followed by `resume`
cannot revive an older invocation: the generation survives reopening admission.
Pause output acknowledges the interruption request, **not** completed tool
cancellation. Callbacks that ignore their abort signal may still be running.

`resume` reopens admission without starting work and refuses unresolved claims.
`wake` supplies evidence to a waiting pursuit without launching a process; an
already-authorized idle background runner can then act on it. It does not revive
terminal work or reopen a paused agenda. `Ctrl+C`/`SIGTERM` ends
the foreground invocation, with any admitted unfinished claim retained.

A crash, provider pause, malformed result, budget stop or cancellation leaves
the claim unresolved. A later run makes no replacement model call for it.
There is no timeout takeover or automatic checkpoint replay. Conversation
`--resume`, `--continue`, `--session`, `--wait-for-provider`, and positive
`limits.waitForProviderMs` are therefore not supported on this surface.

After stopping **all** prior executors and inspecting their effects, reconcile
the exact claim/revision reported by status:

```bash
namzu resident pause
namzu resident reconcile <pursuit-id> "Inspected the output; the prior write exists and must not be repeated." --claim <claim-id> --revision <pursuit-revision> --outcome wait --executor-stopped
```

Reconciliation requires the resident to be paused and the exact current claim
and pursuit revision. `--executor-stopped` is an operator confirmation that old
executors stopped and their effects were inspected, not an OS liveness check.
The supplied summary records that inspection. A `wait` outcome rests indefinitely;
use `wake` and `resume` before a new authorized run. `complete` and `blocked` are
also supported. Stale settlement is refused. Settlement cannot undo or stop an
external effect already in progress.

`archive <pursuit-id>` removes a terminal pursuit from active capacity while
preserving the SDK's historical deduplication and ancestry rules. It does not
delete a conversation, receipt or immutable history file.

## Outcomes and verification

Exit 0 means the control operation or bounded invocation returned cleanly; it
does not imply that every pursuit completed. A `limit` result reports consumed
step capacity, and `paused`/`idle` may mean no work was admitted. A retained
running claim or execution failure returns 1, including paused unresolved work.
Invalid arguments return 64, untrusted execution 77, invalid execution config 78,
and an interrupted invocation 130. Inspect `agenda` and `execution` in JSON output
when scripting the next decision.

Tests cover command registration, configuration/trust boundaries, identity/cwd
binding, decision verification and cleanup. Separate process tests cover shared
admission, rapid pause/resume, cooperative and non-cooperative cancellation,
storage failure, and process death after a synthetic file effect. Reopening
performs no replay; inspected exact-claim settlement fences a late result.

The 2026-09-11 live smoke used the built CLI in separate terminal processes with
Muse Spark low effort. One initial objective prescribed a file-read step and a
follow-up checklist. The first invocation settled a wait; pause persisted, a
paused invocation settled zero steps, and a later process received the saved
summary and completed the pursuit. The final idle invocation admitted no step.
The project fixture remained unchanged.

Those two SDK steps used five model responses and 43,160 reported tokens,
including 24,915 cached tokens. The first step attempted `save_memory`, which
plan mode refused; the host still retained its result summary. The second step
reread the file. This verifies continuity and the permission boundary, not
context efficiency or independent initiative. The cost ledger marked tokens
unpriced, so its zero total is not proof of a measured bill. Source/build hashes,
filtered tool outcomes and receipts are retained in
[the synthetic evidence](../../research/resident/results/2026-09-11-cli-live.json).

This surface does not expose model-authored subgoal admission, learning promotion,
external outbox delivery or a TUI dashboard. Those SDK capabilities remain
separate integrations. It also does not implement OS service supervision, full
transcript continuation, automatic recovery or physical history compaction.
