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

### Context for a resident step

`run` and `start` accept `--context-profile resident|interactive`, default
`resident`. The resident profile uses the SDK's
[resident context contributions](../sdk/resident-context.md) to separate stable
work and evidence guidance from the current objective, saved summary, wake
reason and approved learning. The CLI also supplies current environment,
memory recall and host instructions outside the stable prefix. These snapshots
are captured for each admitted invocation and remain present on every model
iteration, including after compaction.

Project instructions and tool permission enforcement use their existing paths.
The resident profile also distinguishes historical answers from current-state
questions and asks for labelled alternatives or clarification when a reference
is ambiguous. A current-state answer needs fresh permitted evidence; unavailable
evidence must remain explicit. This is SDK model guidance, not host-enforced
semantic validation. The [CLI interpretation study](../../research/resident/interpretation.md)
records actual request evidence and live answers separately.

The default read-only mode still forbids mutations, while allowing a read-only
objective to finish. It no longer tells a resident to produce an interactive
coding plan and wait for the user to leave plan mode. The host retains its
decision format, answer validation and claim settlement rules.

Use `--context-profile interactive` to retain the previous CLI coding doctrine
and interactive plan guidance, including the resident continuation appended to
that prompt. This option is invocation-local and reaches the managed worker;
it is not saved by `add`. Ordinary interactive chat is unchanged.

In the [2026-09-11 context comparison](../../research/resident/context-profile.md),
both profiles waited for reviewer evidence, retained the prior summary, reread
changed notes and completed the review, including a managed background continuation.
The resident profile used 19.35% fewer reported input tokens with the same model
response count in this small synthetic scenario; the result does not establish
improved quality or a measured monetary saving.

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

Project instructions, environment, memory recall and the resident continuation
remain in context. Tool loading is independent of `--context-profile` and does
not change authorization. The option belongs to the invocation, is
not saved by `add`, and does not change ordinary interactive chat. Internally,
`AgentSessionOptions.toolLoading` applies to fresh sends. Checkpoint resume uses
the existing session registry; the fork's activation snapshot is not persisted
or restored. Resident execution refuses checkpoint resume and retains interrupted
claims for inspection instead of replaying them.

In the [2026-09-11 synthetic CLI comparison](../../research/resident/tool-loading.md),
two small tasks used about 29% fewer reported input tokens with deferred loading.
Both completed under both modes; one deferred run used the detached worker.
That comparison used the interactive context profile. These tasks needed no
optional tool, so the result does not measure discovery's
extra round trip or establish a general performance gain.

Iteration, token and run-time limits apply **per SDK step**, not cumulatively across a
resident's lifetime. Explicit zeros in [run limits](run-limits.md) remove those
per-step caps while retaining measured usage. `--max-steps` bounds the number of admitted steps. Provider
failures and interrupted steps can consume tokens without settling a step.
The read-only lifetime projection below does not enforce a separate lifetime credit limit.

`--max-idle-ms` bounds a single idle wait, default 60,000. A later scheduled wake
outside that window returns control to the shell. An indefinite wait, completed
agenda or paused agenda makes no model call. While running, local storage checks
observe operator controls; these are not model heartbeat calls.

Use `--cwd <path>` to select a project and `--agent <name>` to select a resident
within it. The default name is `default`; names contain 1–64 lowercase letters,
digits, underscores or hyphens and start with a letter or digit. These are
operator names, not another family of generated entity IDs.

## Consumption and completion evidence

Use `namzu resident inspect` to read retained execution evidence across process
restarts, including pursuits already archived. It makes no model calls, starts
no worker, changes no permissions and does not reconcile an unresolved claim.

```bash
namzu resident inspect
namzu --format json resident inspect
namzu resident inspect --max-revisions 1024
namzu resident inspect --cursor 257 --through-revision 500 --max-revisions 256
```

`status` shows current admission/runner state; `inspect` reads immutable agenda
history and scoped attempt/run receipts. Its result separates:

- **Admitted work** from agenda settlement. A callback finish receipt alone
  does not prove the agenda committed the result. Manual reconciliation can
  settle a claim without manufacturing model usage or verification evidence.
- **Own tokens** from **tree tokens** including descendants. These are separate
  totals; adding them would count the root twice. Retry/side-call tokens already
  included in a root's cumulative usage are counted once. Cache token buckets
  are not added again.
- **Recorded verification** from an unconfigured completion. Inspection checks
  receipt identity, scope, policy and observation metadata; it does not re-read
  the source or establish that the facts are still true today.
- **Known own cost** from unpriced tokens and missing prices. Descendant prices
  are not included. These estimates are not a provider bill.
- **Partial/unknown usage** from final recorded usage. Abrupt death may leave
  only a provisional run snapshot. Reconcile, archive and restart never turn
  that uncertainty into zero or remove its retained admission.

The text view shows at most 20 inspected attempts; JSON retains all attempts in
the inspected range. The default scan covers up to 256 revisions, with at most
8 MiB of history reads and 16 MiB reserved for attempt/run receipt reads. Each
attempt reserves three bounded 64 KiB reads. `--max-revisions` accepts 1–4096;
`--cursor` starts at the next revision returned by a prior inspection.
Use `--through-revision` with the original upper boundary when paging an active
resident; otherwise each invocation selects the latest saved boundary. Receipt
reads reflect the evidence available during inspection, not a historical wall-clock snapshot. The
returned cursor is for **history** continuation; a receipt deferred by its
separate allowance remains deferred. SDK callers can raise that allowance to
64 MiB or inspect smaller revision ranges.

An incomplete scan is labelled partial, even when the last page reaches the
end. Do not add overlapping page totals or interpret a page as a lifetime
total. A complete lifetime view starts at revision 1, reaches the selected
upper boundary and has no unavailable revisions. Missing, invalid or deferred
receipts remain separately visible even with complete history. The SDK exposes
the underlying [source and projection](../sdk/resident-agents.md#activity-and-consumption-inspection)
for hosts needing their own presentation.

This is accounting, not a new spending gate. Existing token/iteration limits
still apply per step; `--max-steps` remains an invocation allowance.

## Directory and state ownership

Residents reuse the installation tenant and the CLI's canonical
[Project binding](project-state.md). The first `add` saves its canonical execution
directory. Opening a subdirectory of the same checkout selects the same resident
and still executes in the saved directory. A missing directory, changed canonical
target or mismatched Project refuses execution; it does not silently relocate work.

Bindings and attempt receipts live below
`NAMZU_HOME/residents/<projectId>/<agent>/`, or the equivalent
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
immutable objective, identity, last saved summary, all pending wake inputs and an approved
[learning snapshot](../sdk/resident-learning.md) bound to the admission revision.
Learning projection has a 12,000-character cap and selects currently active
host-approved skills. Oversized entries are reported as omitted. Continuation uses this snapshot and bounded historical evidence retrieval; it
does not restore an in-flight process or resume an old chat transcript.

Both context profiles also mount `search_resident_history` and
`read_resident_history` over the SDK's [resident evidence source](../sdk/resident-recall.md).
They retrieve this pursuit's earlier settled summaries and consumed wake inputs,
up to the agenda revision captured for the admission. The tools are ready even
with deferred schema loading and work under the default read-only permission
mode. They are scoped to the owning Session/Run; ordinary chat and delegated
children do not gain access to the resident's archive. The internal composition
option is `AgentSessionOptions.residentHistory`; both foreground and managed
resident execution supply it automatically.

The model can recover a forgotten identifier and compare a later correction
without replaying actions. This does not restore complete historical tool
transcripts or verify that an old report remains true. Search is bounded and
paged; unavailable history is reported explicitly. The
[CLI recall experiment](../../research/resident/history-recall.md) records the
actual search/read calls and their limits.

Both profiles additionally mount `search_resident_tools` and `read_resident_tool`
through `AgentSessionOptions.residentToolEvidence`. These use the SDK's
[retained tool evidence index](../sdk/retained-tool-evidence.md) to recover exact
historical tool text, including authenticated spilled output. The host checks
agenda settlement, matching start/finish pursuit/claim/Session/run identities,
confirmed cleanup and invocation metadata ownership. Resident invocations do
not require a resumable conversation row in SQLite; if one exists, its project
must agree. Missing or inconsistent bindings remain unavailable. A finished
receipt alone cannot authorize an unresolved claim.

The derived index lives under the original invocation's
`sessions/<sessionId>/runs/<runId>/evidence-index/`, so archiving/removing that run
also moves/removes its index. It introduces no new project directory. Per
resident request, history reads are bounded to 8 MiB/32 revisions, invocation
retrieval to another 8 MiB and the two CLI attempt receipts to 64 KiB each.
Historical errors and previews remain explicit. The tools never reread a
mutable workspace file, restore a process or re-execute the original action.
Older runs without explicit scope or matching receipts are not guessed into
this feature. The [tool-evidence experiment](../../research/resident/tool-evidence.md)
records real CLI execution separately from its scripted provider seed.

Both context profiles also attach SDK
[automatic original-tool recall](../sdk/resident-evidence-recall.md) before each
model request. It selects literal terms from the admitted objective, accepted
wake inputs and derived summary, then retrieves bounded original tool excerpts
from earlier settled admissions. Historical Session/claim addresses remain intact.
The pass has a combined 8 MiB document allowance and at most four source pages;
explicit tools remain available for omitted text and cursor continuation.
Long inputs contribute words from both ends. A full result page can trigger
one search for uncovered words at the same authenticated archive position;
its pages and bytes still count against that shared allowance. This improves
some crowded searches without resolving ambiguous references or guaranteeing
that every relevant historical observation is selected.
`compaction.recallEvidence: false` disables this preparation while retaining
explicit tools. No extra query-planning model call is made.

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
`wake` appends evidence to a waiting pursuit without launching a process; an
already-authorized idle background runner can then act on it. It does not revive
terminal work or reopen a paused agenda. `Ctrl+C`/`SIGTERM` ends
the foreground invocation, with any admitted unfinished claim retained. Resident
Sessions disable the SDK emergency exit handlers because the enclosing resident
host owns these signals and must drain the Session and write its finish/runner
receipts first. Ordinary interactive chat keeps its existing emergency policy.

Several wakes before the next step are retained in order, including after
restarting Namzu. `status` shows the pending input count; JSON status includes
each reason and its receipt time. Both context profiles supply the complete
batch to the step. At most 16 inputs and 16,000 total reason characters can be
pending; overflow refuses the new input without discarding earlier evidence.
Successful settlement consumes the batch, so the step must preserve unresolved
facts in its next summary. Interrupted claims retain their inputs until explicit
inspected reconciliation. This is a waiting-state queue, not mid-step steering.
Consumed inputs remain accessible through resident recall in immutable history;
they are no longer automatically projected into the next step's prompt.
See the SDK's [wake evidence contract](../sdk/resident-agents.md#retaining-wake-evidence).

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
## Configured claim verification

`namzu resident run --max-steps 1 --verify checks.json` enables explicit JSON
claim checks for that invocation. `resident start` accepts the same option and
passes the validated policy snapshot to its managed worker. `add` does not save
this authority. Subsequent invocations require the option again. The same
requirements apply to every pursuit admitted by that invocation; use a separate
resident when pursuits need different completion policies.

For example, an operator-owned `checks.json`:

```json
{
  "version": 1,
  "claims": [
    { "id": "version", "source": "package.json", "pointer": "/version" }
  ]
}
```

Add `"expected": "3.0.0"` to require that version as a postcondition. Without it,
the check verifies the reported version, not that a particular upgrade occurred.
The model receives the required IDs, sources, pointers and expected values. A
`complete` decision must also contain `"claims": { "version": "3.0.0" }` with
the observed values. `wait` and `blocked` omit claims; their summaries are retained
as model statements, without a verification badge or factual guarantee.

The host validates claims through SDK `createJsonClaimVerifier` after any configured
`--gate` command finishes. Rejected claims enter the existing answer-review repair
loop (three rejections by default). Exhaustion or interrupted work keeps the
resident claim unresolved. A valid blocked disposition can settle honestly without
inventing a current value. Final completion must match the exact answer hash of
the accepted review; a different answer or a path that bypassed review cannot settle
as complete. `finish.json` retains the policy and successful observation receipt,
including authorization scope, checked fields, hashes and times. This records the
callback outcome; durable agenda settlement remains a separate fact.

The option explicitly authorizes **host file reads**, as `--gate` authorizes host
commands. These reads run outside model-tool approval and sandbox handling; they
do not grant new tool permissions. Use a manifest you control. It must be smaller
than 64 KiB and is snapshotted before admission. Sources must be relative workspace
paths without traversal; resolved targets outside the workspace are refused.
Only bounded regular files are read, under a shared 1 MiB allowance and two-second
review deadline. File identity/size/timestamps are checked across the read; symlink
and path checks are not OS confinement against a hostile filesystem race. Missing,
oversized, malformed or changing sources cannot verify completion. Outstanding
reads after cancellation retain uncertain cleanup/runner ownership.

Only the configured structured fields are checked. Arbitrary prose, overall task
correctness and future file state are not proved. Multiple files are observed
sequentially, not atomically. The default without `--verify` retains ordinary
decision-shape review and any explicitly configured command gate.

## Explicit learning experiments

`learn` runs a deliberately selected executable host module through the SDK's
[stored learning cycle](../sdk/resident-learning-storage.md). `learning` inspects
its durable records without executing the module or starting a model:

```bash
namzu resident learn /absolute/path/source-check.learning.mjs --trust --cwd /absolute/path/workspace
namzu resident learning --cwd /absolute/path/workspace --limit 20
namzu resident learning <cycle-uuid> --events --after 0 --limit 32 --cwd /absolute/path/workspace
```

An existing unpaused resident with no running pursuits is required. `--agent`
selects its key (default `default`). Use the same canonical workspace as that
resident. The module must be an explicit regular `.learning.js` or `.learning.mjs`
file with a default factory. There is no automatic module discovery or replay.

The factory receives `{cwd, tenantId, projectId, agentKey, signal, store}` and
returns `Omit<ResidentLearningCycleOptions, 'agenda' | 'signal' | 'record'>`.
It should only configure callbacks and read retained evidence: all model and
review calls belong inside the charged `generate` and `evaluate` callbacks.
The CLI supplies the bound agenda, cancellation and durable journal. The factory
chooses its own installed SDK providers, exact models, effort, tools, per-run
budgets and independent scoring. It does not inherit an interactive model or
silently choose one. A factory can save run traces with
`store.putArtifact(context.cycleId, name, value)` after the cycle starts.

This is executable host code, like a local eval suite. `--trust` accepts that
execution; it is **not a sandbox for the module**. The host must propagate the
signal and enforce limits on every operation it starts. The SDK's stage resource
policy accounts for observed usage and controls admission to later stages; it
is not a reservation that can cap a model request already in flight.

The checked-in `research/resident/tool-learning-host.mjs` and
`tool-learning-study.mjs` form a complete isolated example with real SDK file
tools. Run the study without `--live` for scripted inference, or explicitly with
`--live` for bounded Zen Muse/low calls. The study creates its own temporary home,
fixtures and host module and invokes the built CLI; it does not modify personal
residents. Its [evidence report](../../research/resident/learning-storage.md)
distinguishes scripted plumbing checks from live quality measurements.

`learning` lists status and recorded consumption. A missing final receipt remains
explicit; neither a `running` record nor a past `activated` event establishes
that an executor or skill is active now. Current skill authority remains the
resident agenda, including later rollback. Inspect a cycle for artifact hashes
and optionally paginated events. `--before` pages the cycle list, while `--after`
applies only to `--events` with a cycle ID. JSON output exposes `nextBefore` or
`nextAfter` along with the records.

`learn` exits 0 for acknowledged activation with a complete journal, 2 for a
rejected or inconclusive experiment, 130 for cancellation, and 1 for other
execution outcomes. Usage errors return 64 and a refused trust admission 77.
A failed final journal append preserves the actual activation acknowledgement
and asks for evidence inspection. It never automatically retries an experiment.
