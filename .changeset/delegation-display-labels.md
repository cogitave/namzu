---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Delegation display labels now ride the `agent_pending` event. `RunEvent`'s `agent_pending` variant, `CreateTaskOptions` and `SendMessageOptions` each gain optional `workflow`, `phase`, `phaseDetail` and `phaseOrder`, and the SSE bridge carries them on `agent.pending` as `workflow`, `phase`, `phase_detail` and `phase_order`.

**These are display annotations only; they do not create dependencies, barriers, or serial execution.** Nothing in the kernel reads them back: admission, capacity, ordering and concurrency are decided by the scheduler, and two children naming the same phase are not thereby sequenced, synchronised or joined. `planId`/`planStepId` remain the delegation fields that carry correlation a host may act on. A reader who infers execution structure from a label here has inferred it from a caption.

What they buy is reach. A label that stays in the delegating process's memory is visible to that process and to nothing else; on the event it reaches every listener the delegation was given, and through `mapRunToStreamEvent` the SSE wire, so a consumer watching from elsewhere rebuilds the same grouping instead of seeing an undifferentiated list of children.

**Reach is not durability, and this does not add persistence.** Delegation lifecycle events are handed straight to a host's listener without passing through the run's event translator, so `agent_pending` enters no run's log — which is what the absent `seq` on these variants has always meant. A label supplied here is written nowhere by the kernel and does not survive a restart; a host that wants the grouping to outlive its process records it from the listener, into whatever store it already keeps.

Minor, and nothing to do on the upgrade: every field is optional and absent unless a host supplies one, no export was removed or renamed, no union narrowed, no default changed. A host that supplies none sees byte-identical events and wire payloads. The A2A bridge continues to emit nothing for delegation events — deliberately, and now said so in its comment: a peer models one task lifecycle and has no screen of ours to caption.

The CLI change is behaviour-preserving (`patch`): the `Agent` tool sends the labels it already collected down onto the delegation, and its activity monitor reads them off the event with the launch-time values kept as the seed, so a child that fails before `agent_pending` still groups where it was launched. For a run supplying the same labels on both paths — which is every CLI run — the grouping is byte-identical to before.
