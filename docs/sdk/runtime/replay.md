---
title: Replay
description: Fork an existing run from any checkpoint with optional controlled mutations. Useful for debugging, regression tests, and counterfactual "what if" analysis.
last_updated: 2026-04-21
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
import { listCheckpoints, prepareReplayState, query } from '@namzu/sdk'
import type { Mutation, RunId } from '@namzu/sdk'

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
    toolCallId: 'call_xyz' as never,
    response: { success: true, output: 'mocked response' },
  },
]

const prepared = await prepareReplayState({
  baseDir: '/path/to/.namzu/runs',
  runId: 'run_source_abc' as RunId,
  fromCheckpoint: entries[entries.length - 1].id, // or 'latest' / 'emergency'
  mutate: mutations,
})

// Step 3 — hand the prepared state to your own query() call. You are
// expected to bring the provider, tools, resume handler, and session
// context — the same bundle you would use for a new run.
const replayRun = await drainReplayRun({
  messages: prepared.messages,
  resumeFromCheckpoint: prepared.sourceCheckpoint.id,
  // ...your provider, tools, runConfig, sessionId, threadId, projectId,
  //    tenantId, agentId, agentName, resumeHandler, etc.
})

// Step 4 — stamp attribution on the run record so callers downstream can
// tell a replay from an original.
replayRun.replayOf = prepared.attribution
```

`prepareReplayState` is pure-read — it touches the source run's checkpoint files but never writes. Running it twice on the same inputs (modulo `replayedAt`) produces the same prepared state.

## 3. Fork Points

`fromCheckpoint` accepts three shapes:

| Value | Meaning |
| --- | --- |
| `CheckpointId` (e.g. `cp_abc123`) | Exact checkpoint by id. Resolve via `listCheckpoints` first. |
| `'latest'` | Highest `iteration` checkpoint for the run. Throws if the run has no checkpoints. |
| `'emergency'` | Project the run's emergency dump (written on SIGINT/SIGTERM) into a synthetic checkpoint. Requires `emergencyDir` to be passed. |

The `'emergency'` selector is lossy — `costInfo`, `guardState.elapsedMs`, `toolResultHashes`, `branchStack`, and `activeNode` default to zero/empty values because the emergency snapshot does not capture them. The synthetic `CheckpointId` is derived deterministically from the emergency save id (prefix `cp_emergency_`), so re-projecting the same dump yields the same id.

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
type ReplayAttribution = {
  sourceRunId: RunId
  fromCheckpointId: CheckpointId
  mutations: Mutation[]
  replayedAt: number
}
```

Stamp it on the new run as `run.replayOf = prepared.attribution` before persisting. Downstream code that reads `Run` sees `replayOf === undefined` for original runs and a populated `ReplayAttribution` for replays. Use this to filter replays out of production dashboards, tag them in traces, or diff them against the source.

## 7. Security

`prepareReplayState` and `listCheckpoints` read the source run's directory directly — they do not consult a multi-tenant gatekeeper because today there is no tenant field on `Run` or on the `RunDiskStore` read API. Single-tenant deployments are safe by default; multi-tenant operators must enforce tenant scoping at the caller (e.g. by validating the `runId` belongs to the requesting tenant before invoking replay).

When the end-to-end `replay()` wrapper lands (follow-up session), tenant scoping will go through `RunPersistence`, which already carries `tenantId`.

## 8. Non-Scope

Not in v1; deferred with a dedicated follow-up:

- **Deterministic verbatim reproduction** ("reproduce mode"). Requires provider-output caching and tool-response caching across iteration, compaction, advisory, and tool-review phases.
- **`replay()` end-to-end entry.** Needs a `ReplayEnvironment` bundle design — different call sites expect different combinations of provider, tools, session scope.
- **CLI (`namzu replay <runId>`).** Waits on `@namzu/cli` publication.
- **Export / import of captured runs** for off-machine bug reports. Returns with the CLI session, paired with a redaction story.
- **Visual time-travel UI.** Separate deliverable; this page documents the primitive.

## 9. References

- [`ses_005-deterministic-replay`](https://github.com/bahadirarda/namzu/tree/main/docs.local/sessions/ses_005-deterministic-replay) — design record, ratified decisions, implementation plan. Internal; linked here for context on what was cut from v1 and why.
- `projectEmergencyToCheckpoint` — exported helper if you want to project emergency dumps yourself rather than letting `prepareReplayState` do it.
- `CheckpointManager.listEntries()` — the lower-level method that `listCheckpoints` wraps, useful if you already hold a `CheckpointManager` for the run.
