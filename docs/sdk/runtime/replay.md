---
title: Replay
description: Fork an existing run from any checkpoint with optional controlled mutations, resume a parked run from another process, and enumerate the runs waiting on a human or on a reclamation sweep.
last_updated: 2026-08-09
status: current
related_packages: ["@namzu/sdk"]
---

# Replay

Replay lets you fork an existing run from any stored checkpoint and continue execution from that point. Optionally you inject a different tool response at the fork point to explore counterfactual paths. It is the primitive behind "this run failed at iteration 47 — let me re-run from iteration 45 with a mocked tool response and see where it diverges."

## 1. What This Is (and Is Not) in v1

**What v1 delivers.** Forked execution from a captured checkpoint, with a minimal mutation surface. You can:

- List a run's checkpoints.
- Pick a fork point (`CheckpointId`, `'latest'`, or `'emergency'`).
- Optionally mutate the state at the fork point — currently only `injectToolResponse`.
- Thread the prepared state into your own `query(...)` call and get a fresh run with `replayOf` attribution.

**What v1 explicitly does NOT deliver.** Byte-for-byte verbatim reproduction. Past the fork point, the provider returns whatever it returns now; tools hit live external state. If the model or the world has changed since the original run, the replay will diverge — that is expected and documented. Deterministic "reproduce mode" (cached provider outputs + tool-response cache) is a future session.

**Also not in v1.** A single-call `replay({ runId, opts })` wrapper. The end-to-end entry needs a "replay environment" — provider instance, tool registry, session context, resume handler — that is not recoverable from the source run's on-disk meta alone. The wrapper lands in a follow-up session with its own design pass. For now, compose the two-step flow below.

## 2. Two-Step Composition

The runtime ships two public helpers that together cover the v1 flow:

```ts
import { drainQuery, listCheckpoints, prepareReplayState } from '@namzu/sdk'
import type { Mutation, QueryParams, RunId, ToolCallId } from '@namzu/sdk'

// Step 1 — discover checkpoints for the source run.
const entries = await listCheckpoints({
  baseDir: '/path/to/.namzu/runs',
  runId: 'run_source_abc' as RunId,
})

// Step 2 — prepare the forked state at a chosen checkpoint, optionally
// with mutations applied at the fork point.
const mutations: Mutation[] = [
  {
    type: 'injectToolResponse',
    toolCallId: 'call_xyz' as ToolCallId,
    response: { success: true, output: 'mocked response' },
  },
]

const prepared = await prepareReplayState({
  baseDir: '/path/to/.namzu/runs',
  runId: 'run_source_abc' as RunId,
  fromCheckpoint: entries[entries.length - 1].id, // or 'latest' / 'emergency'
  mutate: mutations,
})

// Step 3 — hand the prepared state to your own query() call — `drainQuery`
// is the awaitable form of it. Pass `prepared.messages` as `messages` and
// DO NOT pass `resumeFromCheckpoint` — the mutated history already encodes
// the restored state plus any injected tool response, and the resume path
// would reload the checkpoint's unmutated messages and silently drop your
// mutation.

// Everything a run needs that the replay does not change: provider, tools,
// runConfig, sessionId, topicId, projectId, tenantId, agentId, agentName,
// resumeHandler, …
declare const params: Omit<QueryParams, 'messages' | 'resumeFromCheckpoint'>

const replayRun = await drainQuery({
  ...params,
  messages: prepared.messages,
  // NOT: resumeFromCheckpoint: prepared.sourceCheckpoint.id
})

// Step 4 — stamp attribution on the run record so callers downstream can
// tell a replay from an original.
replayRun.replayOf = prepared.attribution
```

**Why no `resumeFromCheckpoint`.** The query runtime's resume branch (`packages/sdk/src/runtime/query/index.ts`) exists for HITL-style mid-run resumption: it re-reads the stored checkpoint's messages into the run state, ignoring `params.messages`. For replay we want the *mutated* message history — which `prepareReplayState` already produced. Seed it via the normal `messages` input and skip the resume branch. A future 5b wrapper will hide this detail behind a single `replay()` entry.

`prepareReplayState` is pure-read — it touches the source run's checkpoint files but never writes. Running it twice on the same inputs (modulo `replayedAt`) produces the same prepared state.

## 3. Fork Points

`fromCheckpoint` accepts three shapes:

| Value | Meaning |
| --- | --- |
| `CheckpointId` (e.g. `cp_abc123`) | Exact checkpoint by id. Resolve via `listCheckpoints` first. |
| `'latest'` | Highest `iteration` checkpoint for the run. Throws if the run has no checkpoints. |
| `'emergency'` | Project the run's emergency dump (written on SIGINT/SIGTERM) into a synthetic checkpoint. Requires `emergencyDir` to be passed. |

The `'emergency'` selector is lossy — `costInfo`, `guardState.elapsedMs`, and `toolResultHashes` default to zero/empty values because the emergency snapshot does not capture them. The synthetic `CheckpointId` is derived deterministically from the emergency save id (prefix `cp_emergency_`), so re-projecting the same dump yields the same id.

## 4. Mutation API (v1)

One mutation variant in v1:

```ts
import type { ToolCallId, ToolResult } from '@namzu/sdk'

type Mutation = {
  type: 'injectToolResponse'
  toolCallId: ToolCallId
  response: ToolResult
}
```

`injectToolResponse` covers the 80% debugging use case: "this tool call failed or returned the wrong thing — what would have happened if it had returned X instead?" Applied at the fork point only. If the `toolCallId` you supply is not pending at the fork point (no matching tool call in the last assistant message, or already responded to downstream), the call throws `MutationNotApplicableError`:

```ts
import { MutationNotApplicableError, prepareReplayState } from '@namzu/sdk'
import type { Mutation, RunId } from '@namzu/sdk'

declare const mutations: Mutation[]

async function forkAtLatest(runId: RunId): Promise<void> {
  try {
    await prepareReplayState({
      baseDir: '/path/to/.namzu/runs',
      runId,
      fromCheckpoint: 'latest',
      mutate: mutations,
    })
  } catch (err) {
    if (err instanceof MutationNotApplicableError) {
      console.error('fork point has no matching tool call; pending ids were:', err.availableToolCallIds)
      return
    }
    throw err
  }
}
```

`availableToolCallIds` carries the tool ids that *are* pending at the fork point, so the caller can surface them directly rather than guess.

**Mutations deferred from v1.** `truncateAfter`, `swapProvider`, `overrideBudget`, `overrideMessage`, `skipTool`. `truncateAfter` is redundant with picking an earlier `fromCheckpoint`; the rest are real but lower-frequency. Raise an issue if you need one — prioritisation follows demand.

## 5. Determinism Envelope

Read this carefully — the name "replay" is load-bearing and honest disclosure matters.

| Axis | v1 |
| --- | --- |
| Pre-fork state (messages, tool results, iteration count, token usage) | Exact from checkpoint |
| `RunId` of the replay run | Fresh (new id generated when you create the run) |
| Post-fork provider tokens | Live (model calls happen; output may differ from original run) |
| Post-fork tool outputs | Live (tools are re-invoked; external state may differ) |
| Wall-clock timestamps, random ids, external state | Always live |

If you need byte-identical reproduction for regression tests, v1 is not it — those tests should pin inputs + use a mock provider, or wait for the deterministic reproduce-mode session. If you need "start from checkpoint N with a mocked tool response and see what the agent does," v1 is exactly the right primitive.

## 6. Attribution on Replayed Runs

`prepareReplayState` returns an `attribution` record:

```ts
import type { CheckpointId, Mutation, RunId } from '@namzu/sdk'

type ReplayAttribution = {
  sourceRunId: RunId
  fromCheckpointId: CheckpointId
  mutations: Mutation[]
  replayedAt: number
}
```

Stamp it on the new run as `run.replayOf = prepared.attribution` before persisting. Downstream code that reads `Run` sees `replayOf === undefined` for original runs and a populated `ReplayAttribution` for replays. Use this to filter replays out of production dashboards, tag them in traces, or diff them against the source.

## 7. Durable Run State (Resuming in Another Process)

A HITL park used to exist only as a suspended `await` inside one process:
the checkpoint written just before it was indistinguishable from any
mid-run checkpoint, so nothing in durable state said a human owed the run
an answer. An approval queue could not be rebuilt from the store, and a
serverless host could not park a run at all, because the container holding
the promise had to stay alive to receive the answer.

### Finding a parked run

```ts
import { loadRunState } from '@namzu/sdk'
import type { CheckpointStore, ProjectId, RunId, SessionId, TenantId, TopicId } from '@namzu/sdk'

// In a different process: a store and a scope, and nothing else.
declare const checkpointStore: CheckpointStore
declare const tenantId: TenantId, projectId: ProjectId, sessionId: SessionId
declare const topicId: TopicId, runId: RunId

const state = await loadRunState(checkpointStore, {
  tenantId, projectId, sessionId, topicId, runId,
})

if (state?.pending && state.pending.resolvedAt === undefined) {
  // Render `state.pending.request` to a human.
}
```

`IterationCheckpoint.pending` records the `HITLDecisionRequest` verbatim,
and keeps the answer once it arrives — a gate that cannot say what was
approved is not an audit trail. `RunState` is a flat, JSON-safe snapshot;
`parseRunState` refuses a snapshot from an incompatible SDK version rather
than half-restoring a run that looks healthy and has lost its budgets.

### Finding parked runs you do not already know about

`loadRunState` and `findPendingCheckpoint` both need a `runId`, so they
answer "is *this* run waiting" and not "which runs are waiting". The second
question is `listDurableRuns`, a listing above the run:

```ts
import { findPendingCheckpoint, listDurableRuns } from '@namzu/sdk'
import type { CheckpointStore, ProjectId, TenantId } from '@namzu/sdk'

declare const checkpointStore: CheckpointStore
declare const tenantId: TenantId, projectId: ProjectId

// An approval inbox: every outstanding park under one tenant.
let cursor: string | undefined
do {
  const page = await listDurableRuns(
    checkpointStore,
    { tenantId, projectId },
    { park: ['outstanding'], limit: 50, cursor },
  )
  for (const entry of page.entries) {
    // An entry IS a `CheckpointRunScope`, so it goes straight back in.
    const checkpoint = await findPendingCheckpoint(checkpointStore, entry)
    // Render `checkpoint.pending.request` to a human.
  }
  cursor = page.cursor
} while (cursor)
```

The listing scope is a **contiguous prefix** of tenant → project → session.
`tenantId` is required; a `sessionId` with no `projectId` is refused rather
than guessed at, because a flat backend could answer it and a hierarchical
one could not.

Swap the filter for `['expired']` and you have the sweep `hitlParkTtlMs`
describes — every park whose window closed with no answer, ready for
`CheckpointManager.expire`.

Three properties worth knowing before you build on it:

- **Sub-runs are included**, with `parentRunId` on the row. A park is
  durable at any delegation depth, so an inbox that skipped them would drop
  every approval raised by delegated work.
- **Ordering is explicit.** `orderBy: 'runId'` (the default) is stable and
  total and says nothing about age — run ids carry no timestamp.
  `orderBy: 'createdAt'` is the triage order, oldest first, and answers
  which run has been waiting longest.

  Both sort on a key that cannot *move*, which is what a cursor needs. That
  rules out every timestamp a checkpoint store derives on its own: the
  newest advances when the run checkpoints again, the oldest when pruning
  deletes oldest-first. `runCreatedAt` is recorded once when the run is
  attributed and copied onto every checkpoint, so pruning cannot reach it
  and a resume does not restart it.

  Runs whose creation was never recorded come **first** under
  `'createdAt'`, with `runCreatedAt` absent on the row. That is not a
  guessed date: the stamp is written by the checkpoint manager, so a run
  without one was checkpointed by a build that predates the stamp, and
  therefore predates every run that has one. Render the absence as
  "unknown" rather than substituting a time.

  A cursor is a position in one order. Do not carry one across a change of
  `orderBy`, and do not construct one — the listing refuses a cursor it did
  not issue.
- **An entry carries no run status, and cannot.** A checkpoint is written
  mid-flight, so this store cannot tell a run that finished from one that
  died. A crash sweep is: list every run with durable state, intersect with
  your own run records, resume the difference.

### More than one worker on the queue

A listing plus a resume is enough for one worker. Two need arbitration, or
both restore the same checkpoint, both execute its tools, and both write
under one run id — half the work vanishing with no error anywhere.

```ts
import { claimRun } from '@namzu/sdk'
import type { CheckpointStore, DurableRunEntry } from '@namzu/sdk'

declare const store: CheckpointStore
declare const entries: readonly DurableRunEntry[] // one page of the listing above

for (const entry of entries) {
  const claim = await claimRun(store, entry, { holder: 'worker-3', ttlMs: 60_000 })
  if (!claim) continue // somebody else got there first — not an error
  // …resume the run, carrying `claim.fence` on every durable write.
}
```

Add `claimed: false` to the listing options and a reader sees only the work
nobody holds. An **expired** claim counts as unheld: that is what expiry
means, and treating it as held would leave a dead worker's runs invisible
forever.

It is a **lease**, not a lock. Claiming a run whose lease expired succeeds
and mints a higher fence. The previous holder is never notified — it cannot
be, since from the inside a pause, a suspended container and a partition all
look like time not passing — so it wakes and writes as though it still holds.
That is why every durable write should carry `claim.fence`: the store refuses
a write from a superseded holding, and the write is the only place a stalled
worker can learn it lost the run.

Renewing is the same call. There is no separate `renew`, because two code
paths that must agree about who holds a run is one more than can be kept
correct.

`DiskCheckpointStore` **needs a filesystem with hard links** to arbitrate.
It decides the winner by creating one name per fence, and it creates that
name with `link` so the file is never visible before its contents are — an
ordinary exclusive create is open-then-write, and a reader landing in that
gap reads a live claim as expired and puts a second worker on a running run.
On a volume with no hard-link support (some network and removable mounts)
`claimRun` raises `capability_unavailable` naming the code the filesystem
returned. It refuses rather than falling back, because the only fallback is
the publish with that gap in it, and a claim that has silently stopped being
exclusive is worse than one that will not start. Put the base directory on a
filesystem that supports hard links, or run a single writer per run.

`listDurableRuns` is optional on the `CheckpointStore` interface — both
built-in stores implement it, and a store that does not gets a refusal
rather than an empty page, because "nothing is waiting on a human" is not
what "I cannot tell" means. `InMemoryCheckpointStore` is exported as the
reference for a backend of your own; `DiskCheckpointStore` takes its
tenant/project/session as a second constructor argument, because the disk
layout records none of them.

Park recording is lazy (`parkRecordDelayMs`, default 250 ms) so a
programmatic handler never pays for it. The exception is a `pause`
decision, which is **always** recorded: `pause` is not an answer, it is "I
am not answering now, hold this" — and an instant `pause` is exactly the
serverless pattern, where the host cannot block and comes back later.

### Honoring the answer

```ts
import { drainQuery } from '@namzu/sdk'
import type { QueryParams, RunState } from '@namzu/sdk'

declare const params: Omit<
  QueryParams,
  'messages' | 'resumeFromCheckpoint' | 'pendingDecision'
>
// The parked snapshot `loadRunState` handed back above.
declare const state: RunState

await drainQuery({
  ...params,
  messages: [],
  resumeFromCheckpoint: state.checkpointId,
  pendingDecision: { action: 'approve_tools' },
})
```

`pendingDecision` applies an out-of-band answer to the exact tool calls the
human was shown. Without it the resumed run repairs the unanswered
`tool_use` blocks away and lets the model re-decide, so "yes, delete that
row" degrades into "ask the model again and hope it asks for the same
thing".

It applies only to a `tool_review` park — the other kinds leave no tool
calls to apply a decision to — and is **refused** when the checkpoint's
tool calls no longer match the recorded request: consent to one batch is
not consent to a different one. In that case the repair path runs as
before.

### Reconnecting to a run you were watching

**New in `@namzu/sdk` 21.0.0.** Every event a run records durably carries a
`seq` — its position in that run's own event log, from 1 — and the log can be
read back. Together they are how a consumer that lost its connection catches
up instead of re-deriving the whole run from scratch.

```ts
import { resumeRun } from '@namzu/sdk'
import type {
  CheckpointStore,
  QueryParams,
  RunEvent,
  RunLease,
  RunStateScope,
} from '@namzu/sdk'

declare const params: Omit<QueryParams, 'messages' | 'runId' | 'resumeFromCheckpoint'>
declare const scope: RunStateScope
declare const checkpointStore: CheckpointStore
// From `claimRun` above — `null` when nobody fenced this run.
declare const claim: RunLease | null
declare const stream: { write: (event: RunEvent) => void }

const outcome = await resumeRun({
  ...params,
  scope,
  checkpointStore,
  // The last `seq` this consumer actually received.
  eventCursor: { sinceSeq: 41, generation: claim?.fence },
  listener: (event) => stream.write(event),
})

if (outcome.resumed && outcome.replay?.status === 'unavailable') {
  // Nothing was delivered. Re-derive from the run's transcript.
}
```

`listener` is also new, and until it existed `resumeRun` drained the run and
discarded every event it produced.

**A `seq` means the event is in the log.** The emitter takes a number, appends
the event stamped with it, and only a write that landed advances the counter
and reaches the live stream — so a cursor never points past the evidence. Its
absence is equally load-bearing and covers three cases: the high-frequency
events that are deliberately never persisted (`text_delta`,
`tool_input_delta`, `reasoning_delta`, `tool_progress`), an event whose durable
write failed, and the delegation lifecycle events (`agent_pending`,
`agent_completed`, `agent_failed`, `agent_canceled` and the three sub-session
variants) which the agent manager hands straight to your listener without
passing through the run's log at all. **Never advance a cursor onto an event
with no `seq`.**

**One cursor per run id.** A parent's stream carries its children's events, and
each run numbers its own log. The SSE mapper stamps `id: "<runId>:<seq>"` for
exactly this reason.

**What comes back is message-granular.** Aggregated assistant text, every tool
result and the full lifecycle are all recovered; the deltas that composed them
are not, and are not meant to be.

`eventCursor` is answered with a verdict rather than a best effort, because a
consumer that receives a *short* catch-up folds a hole into its state and
cannot tell:

| `replay.status` | Meaning |
| --- | --- |
| `complete` | The cursor is already at the log's head. |
| `replayed` | `events` is contiguous from `sinceSeq + 1`. |
| `unavailable` + `cursor_ahead` | The consumer claims more than exists — what a lost log looks like from outside. An in-memory run store on a restarted process seeds at zero while the consumer still holds 400. |
| `unavailable` + `generation_changed` | The run was taken over under a higher claim fence, so the two sequence spaces are not comparable. |
| `unavailable` + `gap` | The store's oldest available event is above `sinceSeq + 1`. A pruning backend, caught at the boundary. |

On any `unavailable` the run still resumes and **nothing** from the log is
delivered. A stale cursor belongs to the client and must not be able to stop
the work.

`generation` is the claim fence (§"More than one worker on the queue"), and it
is absent on an unfenced run. Without it a takeover is invisible: a consumer at
seq 400 reconnects to a run whose store lost its log, the next holder starts at
1, and the cursor silently addresses a different sequence space. Because the
fence only increases, a takeover here is *ordered*, not merely detectable.

`RunStore.readEvents({ sinceSeq })` is the primitive underneath, and it is
**required** on the contract — a store that records a transcript it cannot read
back is write-only evidence. To read a run this process never started, use
`readRunEventsIn(runDir)` rather than binding a `RunDiskStore`: binding one
creates the run directory, and a read that mints an empty run then reports it
as having no events is indistinguishable from a run that genuinely has none.

## 8. Security

`prepareReplayState` and `listCheckpoints` read the source run's directory directly — they do not consult a multi-tenant gatekeeper because today there is no tenant field on `Run` or on the `RunDiskStore` read API. Single-tenant deployments are safe by default; multi-tenant operators must enforce tenant scoping at the caller (e.g. by validating the `runId` belongs to the requesting tenant before invoking replay).

When the end-to-end `replay()` wrapper lands (follow-up session), tenant scoping will go through `RunPersistence`, which already carries `tenantId`.

## 9. Non-Scope

Not in v1; deferred with a dedicated follow-up:

- **Deterministic verbatim reproduction** ("reproduce mode"). Requires provider-output caching and tool-response caching across iteration, compaction, advisory, and tool-review phases.
- **`replay()` end-to-end entry.** Needs a `ReplayEnvironment` bundle design — different call sites expect different combinations of provider, tools, session scope.
- **CLI (`namzu replay <runId>`).** Waits on `@namzu/cli` publication.
- **Export / import of captured runs** for off-machine bug reports. Returns with the CLI session, paired with a redaction story.
- **Visual time-travel UI.** Separate deliverable; this page documents the primitive.

## 10. References

- `ses_005-deterministic-replay` — the design record behind this feature, including what was cut from v1 and why. It is agent working memory, gitignored and never published, so this names it rather than linking to it.
- `projectEmergencyToCheckpoint` — exported helper if you want to project emergency dumps yourself rather than letting `prepareReplayState` do it.
- `CheckpointManager.listEntries()` — the lower-level method that `listCheckpoints` wraps, useful if you already hold a `CheckpointManager` for the run.
