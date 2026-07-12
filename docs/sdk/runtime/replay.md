---
title: Replay
description: Fork an existing run from any checkpoint with optional controlled mutations. Useful for debugging, regression tests, and counterfactual "what if" analysis.
last_updated: 2026-07-13
status: current
related_packages: ["@namzu/sdk"]
---

# Replay

Replay lets you fork an existing run from any stored checkpoint and continue execution from that point. Optionally you inject a different tool response at the fork point to explore counterfactual paths. It is the primitive behind "this run failed at iteration 47 — let me re-run from iteration 45 with a mocked tool response and see where it diverges."

## 0. Fork Is Not Resume

These are two different operations, and until `0.5.0` they were one door with one id — which is how re-driving a finished run could overwrite the record it was re-driving.

| | **Fork** (this page) | **Resume** ([Durable Pause](./durable-pause.md)) |
| --- | --- | --- |
| Entry point | `prepareForkState()` | `query({ resumeFromCheckpoint })` |
| Run id | A **new** one. Provenance recorded as `replayOf` | **The same** run |
| Budget | **New.** It is a different run, so `tokenBudget` / `costLimitUsd` / `maxIterations` are its own | The source's **lifetime** ledger, continued |
| The source run | Opened read-only. Left byte-identical | Continued |
| Refuses | Naming the source run in `runId` (`ForkTargetsSourceRunError`) | A **terminal** run (`RunNotResumableError`) |

Fork a run in a loop and you will pay for it every time. That is what forking is.

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
import { listCheckpoints, prepareForkState, drainQuery } from '@namzu/sdk'
import type { Mutation, RunId } from '@namzu/sdk'

// Step 1 — discover checkpoints for the source run.
const entries = await listCheckpoints({
  baseDir: '/path/to/.namzu/runs',
  runId: 'run_source_abc' as RunId,
})

// Step 2 — prepare the fork at a chosen checkpoint, optionally with
// mutations applied at the fork point. This MINTS THE NEW RUN ID.
const mutations: Mutation[] = [
  {
    type: 'injectToolResponse',
    toolCallId: 'call_xyz' as never,
    response: { success: true, output: 'mocked response' },
  },
]

const fork = await prepareForkState({
  baseDir: '/path/to/.namzu/runs',
  runId: 'run_source_abc' as RunId,
  fromCheckpoint: entries[entries.length - 1].id, // or 'latest' / 'emergency'
  mutate: mutations,
})

// Step 3 — hand the prepared state to your own query() call.
const replayRun = await drainQuery({
  runId: fork.runId,             // the NEW run — never the source's id
  messages: fork.messages,       // the source's history at the fork point
  replayOf: fork.attribution,    // provenance, persisted on the fork's run.json
  // NOT: resumeFromCheckpoint — see below
  // ...your provider, tools, runConfig, sessionId, threadId, projectId,
  //    tenantId, agentId, agentName, resumeHandler, workingDirectory
})
```

**Why the new run id is not optional.** `prepareForkState` mints it, and supplying the *source's* id is refused with `ForkTargetsSourceRunError`. A fork that runs under its source's id is an overwrite with a provenance stamp on it: it replaces the source's `run.json` and `messages.json` and rewrites its index entry. Before `0.5.0` this was reachable, and only a `cancelled` source was protected from it.

**Why no `resumeFromCheckpoint`.** The query runtime's resume branch continues *the same run* from a checkpoint: it re-reads the stored checkpoint's messages into the run state, ignoring `params.messages`. For a fork we want the *mutated* history — which `prepareForkState` already produced — and we want it under a *new* id. Passing the source's checkpoint id here would also look for that checkpoint under the **fork's** directory, where it does not exist. Seed via `messages` and skip the resume branch.

**`replayOf` is persisted now.** Pass it as a `query()` param and it is written onto the fork's `run.json`. (In `0.4.x` you stamped `run.replayOf` on the returned object yourself, which never reached disk.)

`prepareForkState` and `prepareReplayState` are pure-read — they touch the source run's checkpoint files but never write. Running them twice on the same inputs (modulo `replayedAt`) produces the same prepared state. `prepareReplayState` is the lower-level of the two: it prepares the state but mints no id, so `prepareForkState` is the entry point you want unless you are naming the new run yourself.

### Forking a checkpoint that was parked on a decision

If the checkpoint you fork from was **parked on a pending decision** (a run waiting for a human), the fork does not carry that decision across. The fork is a timeline in which the human never answered: the pending tool call is repaired away like any other dangling pair, and `PreparedFork.discardedPendingDecision` names the request that was dropped, so you can tell.

To *answer* the decision instead of abandoning it, you do not want a fork — you want to resume the source run. See [Durable Pause](./durable-pause.md).

## 3. Fork Points

`fromCheckpoint` accepts three shapes:

| Value | Meaning |
| --- | --- |
| `CheckpointId` (e.g. `cp_abc123`) | Exact checkpoint by id. Resolve via `listCheckpoints` first. |
| `'latest'` | Highest `iteration` checkpoint for the run. Throws if the run has no checkpoints. |
| `'emergency'` | Project the run's emergency dump (written on SIGINT/SIGTERM) into a synthetic checkpoint. Requires `emergencyDir` to be passed. |

The `'emergency'` selector is lossy — `costInfo`, `guardState.elapsedMs`, `toolResultHashes`, `branchStack`, and `activeNode` default to zero/empty values because the emergency snapshot does not capture them. The synthetic `CheckpointId` is derived deterministically from the emergency save id (prefix `cp_emergency_`), so re-projecting the same dump yields the same id.

**An emergency dump taken while the run was parked on a decision cannot be projected**, and `projectEmergencyToCheckpoint` throws `EmergencyProjectionUnresumableError` rather than producing a corrupted fork. The dump does not carry the pending decision, so projecting it would leave an unowned dangling tool call that the repair would rewrite into "tool result missing" — destroying the very decision the run was parked on. The error names the **real** checkpoint, which has the decision intact and is resumable. Resume from that instead.

## 4. Mutation API (v1)

One mutation variant in v1:

```ts
type Mutation = {
  type: 'injectToolResponse'
  toolCallId: ToolCallId
  response: ToolResult
}
```

`injectToolResponse` covers the 80% debugging use case: "this tool call failed or returned the wrong thing — what would have happened if it had returned X instead?" Applied at the fork point only. If the `toolCallId` you supply is not pending at the fork point (no matching tool call in the last assistant message, or already responded to downstream), the call throws `MutationNotApplicableError`:

```ts
import { MutationNotApplicableError, prepareReplayState } from '@namzu/sdk'

try {
  await prepareReplayState({ /* ... */, mutate: [/* ... */] })
} catch (err) {
  if (err instanceof MutationNotApplicableError) {
    console.error('fork point has no matching tool call; pending ids were:', err.availableToolCallIds)
    return
  }
  throw err
}
```

`availableToolCallIds` carries the tool ids that *are* pending at the fork point, so the caller can surface them directly rather than guess.

**Mutations deferred from v1.** `truncateAfter`, `swapProvider`, `overrideBudget`, `overrideMessage`, `skipTool`. `truncateAfter` is redundant with picking an earlier `fromCheckpoint`; the rest are real but lower-frequency. Raise an issue if you need one — prioritisation follows demand.

## 5. History Repair at the Fork Point

A checkpoint taken from an interrupted run can hold a history providers will
reject: an assistant message with tool calls whose results never arrived, or a
tool result whose call was compacted away. Applying a mutation can produce the
same shape.

`prepareReplayState` therefore **repairs the history after mutations are
applied**, so a forked run does not inherit a dangling pair from the run it
forked. The repair is `repairDanglingMessages()`, which is exported if you need
it directly:

```ts
import { repairDanglingMessages, prepareResumeMessages } from '@namzu/sdk'
```

It heals rather than deletes — orphaned tool results are dropped, missing results
are synthesized deterministically as explicit error placeholders, and every
result is relocated to sit immediately after its assistant message in the
declared `toolCalls` order. It is pure and idempotent.

`prepareResumeMessages(checkpointMessages, pendingDecision?)` is the resume-path
wrapper: it repairs the history and strips `system` messages, since the prompt is
rebuilt for the new run. Pass the checkpoint's `pendingDecision` when it has one
— a run parked on a decision has an unanswered tool call **on purpose**, and
repairing it destroys the question the human was asked. See
[Reliability §7](./reliability.md#7-history-repair).

Note the contrast with `removeDanglingMessages()`, which is still exported and
still *deletes* the offending assistant turns. Use `repair` when you want to
continue a conversation; `remove` only produces a valid transcript. See
[Reliability and Cancellation](./reliability.md#7-history-repair).

## 6. Determinism Envelope

Read this carefully — the name "replay" is load-bearing and honest disclosure matters.

| Axis | v1 |
| --- | --- |
| Pre-fork state (messages, tool results, iteration count, token usage) | Exact from checkpoint |
| `RunId` of the replay run | Fresh — minted by `prepareForkState`. The source's id is refused |
| Budget of the replay run | Fresh. A fork inherits the history, not the ledger |
| Post-fork provider tokens | Live (model calls happen; output may differ from original run) |
| Post-fork tool outputs | Live (tools are re-invoked; external state may differ) |
| Wall-clock timestamps, random ids, external state | Always live |

If you need byte-identical reproduction for regression tests, v1 is not it — those tests should pin inputs + use a mock provider, or wait for the deterministic reproduce-mode session. If you need "start from checkpoint N with a mocked tool response and see what the agent does," v1 is exactly the right primitive.

## 7. Attribution on Replayed Runs

`prepareForkState` (and the lower-level `prepareReplayState`) returns an `attribution` record:

```ts
type ReplayAttribution = {
  sourceRunId: RunId
  fromCheckpointId: CheckpointId
  mutations: Mutation[]
  replayedAt: number
}
```

Pass it to `query({ replayOf })`. It is persisted onto the fork's `run.json` as `PersistedRunMeta.replayOf`. Downstream code that reads `Run` sees `replayOf === undefined` for original runs and a populated `ReplayAttribution` for forks. Use this to filter replays out of production dashboards, tag them in traces, or diff them against the source.

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

- [Durable Pause](./durable-pause.md) — the other half of the split: resuming *the* run rather than forking a new one.
- [`ses_005-deterministic-replay`](https://github.com/bahadirarda/namzu/tree/main/docs.local/sessions/ses_005-deterministic-replay) — design record, ratified decisions, implementation plan. Internal; linked here for context on what was cut from v1 and why.
- `projectEmergencyToCheckpoint` — exported helper if you want to project emergency dumps yourself rather than letting `prepareReplayState` do it.
- `CheckpointManager.listEntries()` — the lower-level method that `listCheckpoints` wraps, useful if you already hold a `CheckpointManager` for the run.
