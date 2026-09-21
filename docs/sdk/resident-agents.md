---
type: Design
title: Resident agents experiment
description: Staged plan and opt-in SDK experiments for durable agendas, internal continuation and honest interruption handling.
resource: packages/sdk/src/manager/resident
tags: [sdk, agents, continuity, research]
status: draft
---

# Resident agents experiment

## Objective and boundary

An agent should be able to retain its identity and an authorized pursuit across
conversation boundaries, take another useful step without another user message,
and wait without spending model calls when there is no useful work.

This is an experimental, opt-in SDK surface. No CLI defaults change. It does not
claim consciousness, independent desires, autonomous goal discovery or a daemon
that survives application shutdown. `@experimental` identifies maturity, not an
exemption from the package's versioning policy.

## Source comparison

- [Background scheduling implementation](https://github.com/NousResearch/hermes-agent/blob/8c74118c4a0c332a6bc57d2509147bad0e6ee864/cron/scheduler.py)
  uses a locked tick, worker ownership and result delivery. Its durable memory
  and reusable skills motivate continuity across separate runs; they are not
  evidence of spontaneous consciousness.
- [Heartbeat contract](https://github.com/openclaw/openclaw/blob/227e7ae26af4e4f3f8a256c4fa808c7b046f4c88/docs/gateway/heartbeat.md)
  separates silent outcomes from notifications and defers busy agents. At this
  revision recurring proactive work is configured explicitly, not inferred from
  old chats by default.
- Namzu already has session goals, revision stores, provider-independent runs,
  persona assembly and memory. `SessionGoalActivation` deliberately grants only
  process-local automatic continuation. The experiment is separate from that
  contract and reuses the existing immutable revision store.

## Delivery plan and acceptance criteria

| Stage | Deliverable | Acceptance evidence |
| --- | --- | --- |
| 1 — initial experiment | Durable identity and one pursuit; developer-owned step; scheduled continuation or indefinite rest | Reopen state between steps; no call before due time or after completion; concurrent owners admit once; uncertain work is not replayed |
| 2 — resident host | Multiple pursuits, cancellation routing, explicit restart authorization and process reconciliation | Kill/restart while idle and during tools; no false completion or repeated unconfirmed effects; foreground operator work can preempt background work |
| 3 — initiative | Propose subgoals within host-approved domains; select using evidence, progress and measured cost | Compare against fixed heartbeat and no-initiative controls; measure useful completed work, redundant work, idle model calls and spend |
| 4 — communication | Durable outbox, delivery acknowledgments, deduplication and quiet hours | Disconnect/reconnect destination; replay pending delivery without confusing generated text with delivered text |
| 5 — learning | Versioned identity/preferences and evaluated reusable skills | Contradict stale beliefs with evidence; evaluate a proposed skill before promotion and roll it back when it regresses |

Stages 1 and 2 have SDK prototypes. Stage 2 supplies local control primitives;
the [resident CLI](../cli/resident-work.md) now hosts explicit foreground work
and observes durable pause generations across local processes. Always-on service
hosting and ordinary TUI integration remain future work. Stage 3 has an opt-in
[initiative prototype](resident-initiative.md) for selection and bounded
subgoal admission, with measured tradeoffs. Stage 4 has a
[communication prototype](resident-communication.md) with atomic outgoing intent,
acknowledged delivery and explicit allowed time windows. Stage 5 now has
[versioned learning and rollback](resident-learning.md), joined with
[terminal archival](resident-retention.md) in an end-to-end SDK experiment. All
five stages have tested prototypes; the CLI exposes a bounded subset. No
outbound messaging or external account access is enabled by this experiment.

## Stage 1 SDK contract

`DiskResidentStore(root, { tenantId, agentKey })` owns one tenant/registry-key
record. `create(identity, objective)` initializes one pursuit. Keys whose encoded segment fits 255 bytes keep their existing filesystem
encoding. Longer encodings use a SHA-256 address; every read still validates the
stored tenant and key, so a mismatched record fails instead of aliasing another
identity. IDs are not inferred from directory names.
Callers supply a trusted, host-owned root. This is logical scope isolation, not
an OS sandbox against a process that can mutate that directory or its symlinks.

`ResidentStore` is the storage contract. Alternative backends must atomically
compare revisions and persist claim admission before allowing work. Disk storage
uses immutable hard-linked revisions; unsupported filesystems fail explicitly.
Revision history is not compacted in this first experiment. It does not promise
power-loss durability or exactly-once external effects.

`stepResident(store, step, signal)` first reads durable state. It invokes no
callback for a completed, blocked, not-due or already-running record. A due step
gets an exclusive revision and claim UUID before the developer callback runs.
The callback receives the identity, objective, prior summary, admission count
and wake reason, then returns one `ResidentDecision`:

- `wait`, `wakeAt: <future epoch milliseconds>`: continue internally later.
- `wait`, `wakeAt: null`: rest until the host supplies new evidence with `wake`.
- `complete`: pursuit is finished; it cannot be woken again.
- `blocked`: a prerequisite is missing; this prototype does not auto-unblock it.

Each decision carries a nonempty summary, limited to 8,000 characters. Only the
last summary is projected into the next callback, alongside pending wake inputs
described below. Full episodic memory, tool
transcripts and arbitrary persistent scratch state are not implemented here.
Use the agenda below for multiple pursuits. Identity and objective remain immutable for this pursuit.

`runResident({ store, step, signal, maxSteps, maxIdleMs })` drives internal
continuation without another user prompt. `maxSteps` is required and finite;
`maxIdleMs` defaults to 60 seconds and bounds each idle wait. Longer waits return
control to the host. These are invocation limits, not a lifetime budget or token
ledger. The host binds normal SDK provider, tool and token policies in `step`.
There is no polling model call: a waiting state is checked locally.

The driver does not watch external store changes while sleeping. Operator
preemption should abort the invocation; `ResidentHost` below also supplies
local wake delivery. An abort interrupts idle sleep, but cannot forcibly stop a callback
that ignores its signal or undo its external effects.

## Stage 2 SDK contract

`DiskResidentAgenda(root, { tenantId, agentKey })` persists one agent identity,
its pause flag and up to 32 pursuits in a single revision. `create(identity)`
initializes it; `add(expectedAgenda, objective)` adds an independently addressed
pursuit. Each has an immutable UUID, its own revision, objective, summary,
admission count and claim. `ResidentState.pursuitId` is populated for agenda
entries and absent in the standalone store. Terminal entries remain in
the active 32-entry bound until explicit [archival](resident-retention.md).
Physical revision compaction is not implemented.

`ResidentAgendaState.pauseGeneration` records durable pause requests. Its absent
value means zero; reading an older agenda does not invent the field. Every
successful `setPaused(expected, true)` increments this nonnegative safe integer,
including requests while already paused. Resuming preserves it. A host can
capture the generation at invocation start and detect a pause even if another
process resumes before its next state read. Observing this field does not itself
deliver cancellation or prove executor quiescence. Agenda writes use schema 6;
schemas 1–5 remain readable, while older writers refuse schema 6.

`ResidentAgendaStore` is the atomic backend contract. All pursuits for an agent
share admission: two processes choosing **different** pursuits still cannot
admit overlapping work. `execution(id)` returns a `ResidentExecutionStore` for
`stepResident` or `runResident`. It exposes only `read`, `claim` and `settle`.
A paused agenda refuses admission even through this lower-level surface.
Pursuit updates may retry up to eight agenda revision conflicts, provided the
original pursuit revision and claim still match. These retries only persist
state; they never repeat the developer callback. Continued contention is surfaced
to the caller. Stale target claims fail instead of overwriting newer evidence.

Choose either standalone storage or an agenda for one executing agent. Their
storage locations are separate; sharing a key between those two independent
stores does not create shared admission.

`ResidentHost(agenda, step)` drives `ResidentPursuitStep(pursuit, signal)`:

- `run({ signal, maxSteps, maxIdleMs, keepAlive })` requires a finite positive step cap;
  idle waits default to at most 60 seconds each. It never starts itself after
  process startup. The host application explicitly authorizes every invocation.
- `keepAlive` defaults to `false`, preserving the return on indefinite rest,
  no remaining work or a scheduled wake beyond `maxIdleMs`. Explicit `true`
  keeps this invocation waiting for new work. It rereads the agenda after each
  idle timer, bounded by `maxIdleMs`, and wakes sooner on `notify()` or a due
  pursuit. `maxIdleMs` must be positive in this mode; it bounds each local
  polling interval, not the total time alive. Empty and terminal agendas spend
  zero model calls while waiting for an addition. The original `maxSteps` cap
  spans every wait, addition and wake; it never resets automatically. Pause,
  unresolved claims, contention, cancellation and the step cap still stop the
  invocation.
- Due pursuits with fewer admitted steps run first; wake time and then UUID break
  ties. This is a deterministic fairness baseline, not an intelligent priority
  policy. Future-dated and indefinite waits do not invoke the callback.
- `pause()` signals this host's active callback and persists closed admission.
  `run` cannot slip in while a control operation is pending; overlapping pause
  writes are serialized. `resume()` requires local work and controls to drain,
  reopens admission, and does not itself execute any work.
- `wake(id, reason)` persists new evidence for a waiting pursuit and interrupts
  this host's idle timer. `notify()` only interrupts local waiting after another
  actor updates storage; it does not change a pursuit's due time or wake an
  invocation that has already returned. A wake racing an asynchronous read is
  retained by the host's local notification generation.
- `ResidentHostResult` reports `idle`, `paused`, `unresolved`, `cancelled`,
  `limit` or `contended`, plus `stepsSettled` and a known `nextWakeAt` when idle.
  `limit` means the invocation consumed its step cap, even if that last step
  completed the final pursuit. It does not assert failure of the pursuit.

For example, using a developer-supplied SDK callback:

```ts
import {
  DiskResidentAgenda, ResidentHost, generateTenantId,
  type ResidentPursuitStep,
} from '@namzu/sdk'

async function runPursuits(root: string, step: ResidentPursuitStep) {
  // Persist and reuse the tenant/key in the host application on future startup.
  const agenda = new DiskResidentAgenda(root, {
    tenantId: generateTenantId(), agentKey: 'research-assistant',
  })
  let state = await agenda.create('A careful research assistant.')
  await agenda.add(state, 'Evaluate cancellation reliability.')
  state = (await agenda.read())!
  await agenda.add(state, 'Evaluate memory usefulness.')
  const host = new ResidentHost(agenda, step)
  return host.run({ signal: AbortSignal.timeout(60_000), maxSteps: 4 })
}
```

The application owns providers, tools, context and budgets within `step`. This
surface adds no default model, tool privilege or TUI control. A persisted pause
survives reopening, but sending an abort signal to an executor in **another**
process requires an application-owned transport. This host does not watch
filesystem changes or interrupt an active callback when another process writes
pause state. With `keepAlive: true`, bounded idle timers reread durable state;
they do not poll a model. Cancellation still requires the application to route
an abort signal when work is active.

**Pause is not quiescence.** After `await host.pause()`, await the original
`run()` promise before treating this host's callback as stopped. A callback that
ignores its signal keeps that promise pending. Awaiting a local invocation says
nothing about a remote executor. An aborted admitted step keeps its claim;
`resume()` cannot bypass this unresolved work. Only after stopping all relevant
executors and checking effects may the application explicitly reconcile it.


## Retaining wake evidence

Successful `wake` calls append to `ResidentState.wakeEvidence`: immutable
`{ reason, receivedAt }` entries in commit order. `receivedAt` is the host's
epoch-millisecond receipt time, not a verified source timestamp; ordering does
not depend on the clock increasing. `reason` still exposes the most recent
input for existing callers. The SDK resident prompt and both CLI context
profiles project the entire batch, so a later successful check cannot erase an
earlier reported failure. Custom callbacks must consume `wakeEvidence` to obtain
every pending input rather than reading only `reason`.

At most 16 inputs and 16,000 total reason characters (UTF-16 code units) may be
pending per pursuit; each reason retains its 8,000-character limit. Overflow
refuses the new wake without changing the revision, due time or accepted inputs.
There is no silent truncation or oldest-entry eviction. Process the admitted
batch before sending more. Concurrent stale writes still conflict; a sender
must reread and retry a rejected write. Identical text can represent separate
events and is not deduplicated automatically.

Admission captures but does not consume inputs. Crashes, cancellation and failed
settlement leave the batch on the unresolved claim. Exact-claim settlement,
including explicit inspected reconciliation, clears it atomically with the new
summary and disposition. The next summary must retain evidence still relevant
to future work. Immutable revisions preserve the prior batch on disk; it is not
automatically replayed into every later step.

This applies to both `DiskResidentStore` and `DiskResidentAgenda`. Standalone
records now write schema 2; agendas write schema 6. Previous schemas remain
readable without invented inputs or receipt times, but older writers refuse the
new versions. Upgrade all processes sharing a resident store together. The
queue accepts evidence only while waiting; it does not enable mid-step steering
or change the running-claim, terminal-work or permission boundaries.

The [CLI regression experiment](../../research/resident/wake-evidence.md) exercises
separate-process wakes and both context profiles with real low-effort inference.
Both retained a failed build and a passing security result instead of losing the
earlier failure. Process tests independently retain the batch after executor
death and require inspected settlement before consuming it.

## Crash and recovery

A failed, aborted or interrupted step retains its running claim. Another reader
reports `idle / unresolved`; this does not assert whether the original process
is alive. Claims have no automatic expiry or takeover. A host must stop the old
executor and inspect its effects before explicitly `settle`-ing the exact saved
claim. Settlement advances the revision, fencing late state commits. It does not
fence already-running external tools; recovery must not be performed concurrently
with them. This conservative first experiment prevents blind replay rather than
pretending to have implemented a distributed execution service.

## Reproducible experiment

After building the SDK and selected driver:

```bash
node research/resident/run.mjs
node research/resident/run.mjs --live
```

The default uses the real SDK loop with a scripted mock provider. `--live` uses
the free public model from the bundled Zen driver with low effort, no tools and
a finite run budget. The script creates only its own temporary directory and
prints its location, actual run outcomes and idle-call count. One initial
objective is provided; there is no second user message between steps. It reopens
the store between the first step and automatic continuation. This is a small
continuity experiment, not an intelligence benchmark or proof of spontaneous
initiative. A provider failure is reported and does not count as completion.

### First live observation (2026-09-11)

The live experiment passed with two low-effort provider calls, both ending with
`end_turn`: a draft, then a revised checklist using the saved summary. The final
state was `complete` with two admissions. The subsequent idle check made zero
model calls. The store was reopened between model calls in the same host
process. A separate two-process test proved exclusive admission and persistence
of the claim after its owner exited. These are different tests; no live model
process-crash recovery claim is made.

The retained synthetic evidence is
`research/resident/results/2026-09-11.json`. No tokens or cost were measured in
this smoke experiment. Both the initial prompt and callback explicitly request
a two-stage task, so this does not establish independent goal selection.

### Host experiment (2026-09-11)

```bash
node research/resident/host.mjs
node research/resident/host.mjs --live
```

The second script creates two distinct two-step pursuits. It drives one step,
pauses, reopens the agenda and host, verifies the durable pause, then explicitly
resumes the remaining steps. A live Muse Spark low-effort run completed all four
calls with `end_turn`. Both pursuits preserved their own prior summaries and
finished with two admissions each. Paused and final idle checks each made zero
model calls. Evidence: `research/resident/results/2026-09-11-host.json`.

Separate deterministic tests cover wake delivery during idle and during a state
read, pause/control races, non-cooperative cancellation, unrelated revision
contention, stale and foreign claims, agenda bounds and finite invocation caps.
A process test kills a worker after it writes a fixture file and before it
settles. Reopening does not reapply the effect; explicit reconciliation after
worker exit and file inspection fences a late result. This uses a synthetic
file effect, not a live model tool or a remote service. A separate process race
admits only one of two different pursuits.

The live prompt explicitly prescribes the two-stage tasks. These observations
establish continuity and control behavior, not spontaneous initiative or a
comparison of intelligence. Tokens and cost were not measured.

## Activity and consumption inspection

The [sustained lifecycle audit](../../research/resident/lifetime-accounting.md)
records a two-hour controlled-provider run, restarts, cancellation, archival,
inspection fault checks and three small Luna/low CLI supplements. The controlled
run retained 30 admissions and two interruptions with incomplete usage; twelve
ten-minute idle intervals produced no model calls. These results validate the
tested lifecycle and inspection cases, not autonomous task quality in general.

`DiskResidentAgenda.activity(throughRevision)` creates a read-only
`ResidentActivitySource` bound to the tenant, agent and immutable upper revision.
Forward pages derive admissions and settlements from adjacent authoritative
revisions, including pursuits subsequently archived. They do not enumerate
attempt directories or trust a model's claim of execution. Each page visits at
most 32 revisions and reads at most 8 MiB; cancellation and unavailable revisions
are explicit. The first cursor is 1. A byte-limited page may make no progress and
returns the same cursor; callers must stop or supply a sufficient allowance.

`inspectResidentConsumption(source, resolver, options?, signal?)` combines these
pages with host-authenticated cumulative root receipts. The host supplies a
`ResidentConsumptionResolver` whose `maxReadBytes` is reserved before each
resolution. Its adapter must enforce that per-resolution bound and cooperative
cancellation. The SDK refuses duplicate admissions, excludes every copy of a turn
receipt reused for multiple claims, validates finite prices and safe token
integers, and never counts cache buckets separately from total tokens.

```ts
import {
  DiskResidentAgenda,
  inspectResidentConsumption,
  type ResidentConsumptionResolver,
} from '@namzu/sdk'

export async function inspect(
  agenda: DiskResidentAgenda,
  receipts: ResidentConsumptionResolver,
  signal?: AbortSignal,
) {
  const state = await agenda.read()
  if (!state) return null
  return inspectResidentConsumption(
    agenda.activity(state.revision),
    receipts,
    { maxRevisions: 256, maxHistoryBytes: 8 * 1024 * 1024 },
    signal,
  )
}
```

A resolver receives only an authoritative `ResidentAdmission`. It returns null
for missing evidence, or a `ResidentConsumptionReceipt` with explicit nullable
own/tree tokens and own price, `usageFinal`, cleanup status and historical
verification status. A provider failure after partial usage must retain its
known numbers with `usageFinal: false`. Absence is not a zero-cost response.
The SDK trusts the adapter's authentication, completeness and byte-bound claims;
it does not independently authenticate a custom backend or price catalogue.

The default whole-inspection bounds are 256 revisions, 8 MiB history and 16 MiB
reserved receipt reads. Hosts can select up to 4096 revisions and 64 MiB receipt
reads. Forward history continuation is `nextCursor`; no inference, automatic
recovery or new execution is performed. A continuation starting after revision 1
remains a partial-range report. Missing history, invalid receipts, deferred
resolutions and provisional usage remain visible. Do not sum overlapping ranges.

`recorded.ownTokens` and `recorded.treeTokens` are **separate** projections; tree
already includes the root. `recorded.ownCostUsd` is the known root estimate,
with compensated addition to limit floating-point drift. Unpriced own tokens,
unknown prices and descendant prices remain distinct. This is not exact decimal
billing and does not reconcile against a provider's account. Root retries and
side calls are included only insofar as their cumulative root receipts recorded
them; missing receipts cannot be reconstructed from an assistant answer.

Identity joins and duplicate checks compare UUIDs independently of hexadecimal
letter case, while preserving the supplied admission identifiers for resolver
lookups. Duplicate-run detection covers receipts resolved in this inspection.
Hosts combining pages must join settlements and deduplicate claim/run identities
over the combined range; per-page scalar totals alone are not sufficient. Read
the activity source for settlements whose admissions occurred on an earlier
page: an inspection report attaches settlements only to its own admissions.

`historyComplete` requires a scan from revision 1 through the fixed upper bound
without missing revisions. `usageComplete` additionally requires final own and
tree usage for every inspected admission. Neither means that every pursuit is
complete, its claims remain currently true, or a message has been delivered.
Archive and manual reconciliation preserve prior consumption and uncertainty.
The existing per-invocation and per-step guards remain unchanged; this API is an
inspection projection, not an atomic lifetime reservation or spending cap.
