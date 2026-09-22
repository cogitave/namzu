---
type: Design
title: Resident learning cycle
description: One host-authorized experiment from recorded failure to generated guidance, paired evaluation, fresh confirmation and durable activation.
resource: packages/sdk/src/manager/resident/learning-cycle.ts
tags: [sdk, agents, learning, evaluation]
status: draft
---

# Resident learning cycle

`runResidentLearningCycle` connects the existing [resident learning](resident-learning.md)
and [harness verification](harness-verification.md) contracts. It generates one
instructional candidate from a recorded failure, requests independent evaluation
and fresh confirmation, and activates accepted content through the agenda's
existing exact-revision transaction. It is an optional SDK workflow, not another
provider loop or an automatically installed background learner.

Optional [`purpose: 'exploration'`](exploration-policies.md) admits a policy for
choosing experiments. The generated candidate must retain that purpose; ordinary
task projection withholds it. The omitted purpose remains task guidance.

The [RSI assessment](../../research/resident/rsi-readiness.md) explains the source
comparison and the distinction between persisted guidance and recursive
improvement of the improvement procedure. This API does not train model weights,
execute generated skill code or establish a generalization result.

## Host responsibilities and execution

`ResidentLearningCycleOptions` requires an agenda with `read` and `promoteSkill`,
a `skillName`, a bounded `failure` containing evidence and a trace, a cancellation
signal, a resource policy, a `protection` plan and three callbacks:

- `generate` receives the failure, active baseline and stage context. It returns
  a candidate with the requested name and an explicit `usageComplete` declaration.
  It can use normal `runAgent` or another host-owned execution path.
- Optional [`explore`](resident-exploration.md) runs first, using normal tools to
  collect model-selected environment experiments. It retains observed outputs
  before synthesis; `generate` receives them through `context.exploration`.
  This path requires no hand-authored correction and shares the cycle's usage,
  cancellation, journal and preservation contracts.
- `evaluate` receives the exact candidate and baseline, their hashes, and the
  stage (`verification` or `confirmation`). It runs and retains its own cases,
  scoring and trace attribution, then returns a `HarnessVerificationBatch` and
  `usageComplete`. Existing `runExperiment` is the intended execution mechanism.
- `record` durably appends each `ResidentLearningCycleEvent` before acknowledging.
  A host can use an owned JSONL file or the optional
  [SQLite learning store](resident-learning-storage.md). Events are delivered
  in sequence even when a callback records several run receipts concurrently.

The host authenticates the source of the failure and the independent evaluator;
the SDK cannot establish either fact from a string label. Confirmation tasks
must remain unavailable to generation. Full evaluation artifacts remain in host
storage: journal entries retain their digests and trace references, not complete
trajectories. Use a fresh experiment identity after an explicitly inspected
failure; there is no automatic replay or resume of a partly executed cycle.
An optional `parentCycleId` records declared ancestry, whose authenticity the
host must enforce.

Only an unpaused agenda without running pursuits can start. The baseline and
agenda revision are captured before generation. Changes are checked at stage
boundaries and activation uses the original snapshot, so a racing update cannot
silently receive evaluation produced for a different baseline. The workflow
does not hold the agenda locked during model calls.

Normalized name, description, body and any host-declared source bindings identify a candidate through
`hashResidentSkill`. A changed name or mismatched evaluation revision is refused.
An identical candidate is rejected without evaluation. The existing review gate
requires at least five tasks with exactly two trials per side, independently
attributed improvement, no observed regression or ambiguous measurement, and a
fresh confirmation of the same size. Each round is bounded to 64 paired tasks.
An already rejected or insufficient verification does not consume confirmation
work. These are engineering acceptance rules, not a statistical proof.

`protection: { verification: [...taskIds], confirmation: [...taskIds] }` is
required before generation. The SDK validates and freezes both selections before
its first callback, records them in the `started` event, and does not expose them
to `generate`. Returning another selection from generation/evaluation cannot
replace the admitted plan. Missing verification controls stop the cycle before
confirmation. Both rounds must satisfy the
[preservation gate](harness-verification.md#declared-preservation-tasks) before
activation. Hosts retain the task inputs/scorers and choose semantic coverage;
strings alone cannot certify independence or freedom from evaluation leakage.

This is a breaking admission requirement: earlier hosts without `protection`
must declare real preservation tasks and include their paired runs in each
batch. Do not label a newly recovered task as a preservation control. The stored
proof records control counts and a plan digest; the full selection remains in
the journal and is included in the evaluation digest. Previously activated
guidance is readable but has no retroactively invented preservation evidence.

## Consumption and cancellation

Each callback must await `context.recordUsage` for every non-overlapping execution,
including generation, unsuccessful cases, reviewers and other side calls.
`ResidentLearningReceipt` contains a UUID `turnId`, `tokens` and `costUsd`.
Unknown fields are `null`. Duplicate UUIDs, including case aliases, are refused;
an invalid receipt invalidates the stage even if the callback catches the error.
There are at most 1,024 receipts in one cycle. Token totals must remain safe
integers, and price totals finite.

Use one accounting convention consistently. For example, do not submit both a
parent's descendant-inclusive usage and its children's own usage. Retry and cache
buckets already present in a cumulative run must not be added again. The SDK
does not authenticate provider receipts or discover this overlap automatically.

The resource policy selects `tokens` or `usd` and a positive `maxUnits`.
Incomplete evidence in that unit stops subsequent stages and activation.
Unpriced work may proceed under an explicit token policy; the result still
reports unknown costs. A stage claiming completeness without any receipt is
incomplete, including when its host needs to report a zero-cost local execution.

`remainingUnits` helps the host plan each stage. Observed exhaustion stops the
next stage; observed excess also prevents activation. This is **not an atomic
reservation or an in-flight spending ceiling**. The host must impose turn limits
and propagate the signal to every model, tool and evaluator it owns. The workflow
waits for callbacks and does not detach an uncooperative executor on cancellation.

`ResidentLearningConsumption` preserves known totals, unknown receipt counts and
unfinished stages. The older numeric `HarnessReview.usage.costUsd` cannot express
unpriced work; use the cycle's consumption fields for that decision. A callback
that fails after recording some runs retains those receipts and leaves its stage
incomplete. A process death requires inspecting the host journal and underlying
run receipts; the SDK does not infer a missing final receipt as zero.

## Activation and recovery

Possible results are `activated`, `rejected`, `inconclusive`, `conflict`,
`cancelled`, `failed` and `activation-unknown`. Every result includes the cycle
identity, available candidate identity, recorded consumption and `auditComplete`.
Stage start/finish, usage, candidate, evaluation and activation-request events
make unfinished work inspectable.

Activation writes the cycle UUID as the learned skill's evidence key. If the
store commits but its acknowledgement is lost, the workflow reports
`activation-unknown`. Inspect the active skill's evidence key and content hash
before taking another action. An error appending the final event after a
successful commit returns `activated` with `auditComplete: false`; it must not
trigger another activation or model replay. Cancellation observed before the
commit prevents it; a successfully acknowledged commit is reported even if
cancellation arrives afterwards.

The next `ResidentHost` admission with `learning: true` can project the accepted
guidance. The existing CLI resident execution path already enables that projection.
`rollbackSkill` appends an explicit reversal using an earlier agenda revision;
neither activation nor rollback rewrites the originally admitted context of an
already running pursuit.

```ts
import {
  runResidentLearningCycle,
  type ResidentLearningCycleOptions,
} from '@namzu/sdk'

async function evaluateOneSkill(host: ResidentLearningCycleOptions) {
  const result = await runResidentLearningCycle(host)
  return {
    status: result.status,
    candidate: result.candidateRevision,
    usage: result.consumption,
    inspectJournal: !result.auditComplete || result.status === 'activation-unknown',
  }
}
```

## Reproducible experiment

The historical `learning-cycle-experiment.mjs` (replay at `f92daf81`) exercises the SDK
workflow with explicitly scripted inference. `--live` selects only Zen's
`muse-spark-1.3-contributor-free` at low effort and enables a real CLI resident
admission. Both use an isolated workspace and Namzu home.

For the current admission contract, use
`node research/resident/learning-protection-study.mjs` (scripted control),
`--regression` (a deliberately damaged protected result), or `--live --prepare`
to prepare an isolated Muse-low experiment for actual CLI/TUI execution. See
[the protection study](../../research/resident/learning-protection.md) for the
fixed-candidate scope and retained results. Historical pre-protection experiments
must be replayed against their recorded revision; their old batches do not
establish the new admission requirement.

The host supplies a synthetic workspace routing convention after observing a
cold knowledge gap. The experiment separates frozen behavior, retained raw
correction and generated guidance in fresh turns. The primary activation comparison
is guidance versus frozen behavior; the raw-memory control may explain the same
gain. Confirmation, holdout, reopening and rollback are separately recorded.
This is a narrow acquired-convention experiment, not a demonstration that
generated guidance outperforms raw memory or that the learner improves itself.

The [recorded Muse/low results](../../research/resident/learning-cycle-results.md)
include all three arms, a real CLI admission after reopening, explicit rollback,
recorded unpriced consumption and a read-only artifact auditor. The raw-memory
and generated-guidance arms achieved the same accuracy in that experiment.
