---
"@namzu/sdk": minor
---

**One canonical run id.** A run now has exactly one id, minted once by whoever starts it, and every layer sees that same id.

Until now it had two. The API minted a run id and handed it to the agent's config builder; the shipped builders dropped it; `ReactiveAgent` passed none to `query()`, which minted its own; and `SupervisorAgent`, `PipelineAgent` and `RouterAgent` each minted theirs inline. The two ids never met because the SSE mapper hid the split: it ignored `event.runId` and stamped its own `runId` argument onto every event it emitted. So the run record on disk was named one thing, the run the client was watching was named another, and nothing could tell you.

- **`BaseAgentConfig` gains `runId?: RunId`.** Supply it and it IS the run id — on the run record, on every `RunEvent`, and in the run's on-disk directory name. Omit it and the agent mints exactly one. `AbstractAgent.resolveRunId(config)` owns the resolution; every agent takes its id from there. Additive.

- **Breaking: `mapRunToStreamEvent(event, runId)` → `mapRunToStreamEvent(event)`.** The second argument is gone. `data.run_id` now comes off the event itself. Any caller passing a run id must drop that argument — a second argument is no longer accepted, and a stale two-argument call will not compile. (`mapSessionToStreamEvent`, its deprecated alias, changes with it.)

- **Breaking for `AbstractAgent` subclasses: `createRunId()` is replaced by `resolveRunId(config)`.** A subclass that minted its own id silently renamed the caller's run. If you subclass `AbstractAgent`, take your run id from `this.resolveRunId(config)` and thread it into `query()`.

- **Behavioural: a sub-agent's events now carry the CHILD's run id.** They used to be relabelled as the parent's on their way to the wire. A spawned child is its own run — its own record, directory and budget — and its events say so, carrying `lineage` to place them under the parent. A client that assumes every event on a run's stream carries that run's id must now read `lineage` (or filter on it) instead. Task lifecycle events (`agent.pending` / `agent.completed` / `agent.failed` / `agent.canceled`) are unchanged: they are the parent's events and keep the parent's id.

Without this, a persisted human-review decision would name a different run than the route answering it. See the [0.5 migration guide](https://docs.namzu.ai/migration/0.5).
