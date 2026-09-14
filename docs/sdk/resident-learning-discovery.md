---
type: Reference
title: Resident learning discovery
description: Select a retained, host-scored failure and admit one deduplicated learning experiment.
resource: packages/sdk/src/manager/resident/learning-store.ts
tags: [sdk, agents, learning, sqlite, evaluation]
status: draft
---

# Resident learning discovery

`runStoredResidentLearningFromObservations` selects a failure from the
[learning store](resident-learning-storage.md) and runs the existing
[learning cycle](resident-learning-cycle.md). The host supplies authorized
evaluators, generation and evaluation callbacks. The SDK chooses the retained
failure; a generated claim of success never replaces verification or confirmation.
This opt-in experiment changes instructional guidance, not model weights or the
kernel's executable code. It does not install a background executor.

Discovery hosts also declare `protection` before generation, using the same
preservation tasks and two-round requirements as explicit learning cycles.
Selecting a retained failure does not select or manufacture unrelated successful
controls; the host remains responsible for that coverage.

## Recording observations

`store.observe(observation)` records an immutable `ResidentLearningObservation`:

| Field | Meaning |
| --- | --- |
| `runId` | UUID of the retained execution, canonicalized to lowercase. |
| `taskKey` | Stable task identity including input and source revision. Retries of the same task keep this key. |
| `skillName` | Guidance slot that could improve this task family. |
| `baselineRevision` | `hashResidentSkill` of the guidance used, or `none`. |
| `evaluatorRevision` | Host-owned evaluation contract and execution conditions. Include the provider, model, effort and relevant harness/tool configuration; changing them requires a new revision. |
| `outcome` | Independently checked `passed` or `failed`, or `execution-error` / `unresolved`. |
| `usageComplete` | Host checked that all owned requests and usage receipts settled. Unknown usage is false. |
| `evidence`, `trace` | Provenance and a retained trace up to 32,000 characters. Never model confidence alone. |

The host must derive these fields from retained runs and an independent evaluator.
The store validates shape and consistency; it cannot authenticate arbitrary
caller-supplied scores. A timeout, refusal, provider failure or missing execution
receipt is not evidence that a reasoning strategy needs replacement. Successful
tasks may also be recorded: a newer pass suppresses older failures of that same
task under identical evaluator and baseline conditions.

Identity is scoped to tenant, project, resident, run, evaluator and skill.
Reinserting identical content is idempotent; conflicting content is refused.
Regrading a run uses a new evaluator revision and preserves the earlier judgement.
Original execution transcripts and usage accounting remain in their existing stores.

## Selection and admission

```ts
import {
  runStoredResidentLearningFromObservations,
  type ResidentLearningDiscoveryOptions,
  type SqliteResidentLearningStore,
} from '@namzu/sdk'

async function improveOnce(
  store: SqliteResidentLearningStore,
  host: ResidentLearningDiscoveryOptions,
) {
  // host.evaluators names the authorized skill/evaluator pairs.
  // The current installed baseline is read from host.agenda.
  const { observation, cycle } = await runStoredResidentLearningFromObservations(store, host)
  return { selectedRun: observation?.runId ?? null, outcome: cycle?.status ?? 'idle' }
}
```

Discovery options replace the cycle's `skillName` and `failure` with `evaluators`:
one to sixteen `{skillName, evaluatorRevision}` pairs, one per skill. All other
execution, resource, signal and callback requirements are unchanged. If a host
also supplies `skillName`/`failure`, discovery selects from observations and
does not use those explicit-failure fields.

Selection considers settled failures matching the current installed skill hash
and the authorized evaluator revision. Already attempted tasks and failures
superseded by a newer pass are excluded. Across remaining targets, the oldest
insertion wins. This is FIFO fairness, not a probability of improvement or an
implementation of GEPA's Pareto search. Repeated runs of one task earn no extra
priority. The query uses scoped indexes and returns at most one row per target;
it does not load every retained trace into memory.

`store.selectObservation(targets)` exposes this read-only selection for hosts that
need to inspect it. Each `ResidentLearningTarget` includes the current
`baselineRevision`. Inspection reserves nothing. Discovery checks again at the
cycle's start: the exact failure, current baseline and still-eligible task must
match. Concurrent selectors may choose the same observation, but only one can
claim it and begin generation. The claim and the `started` event commit in one
SQLite transaction, before any model call.

One attempt is retained per task, skill, evaluator and baseline in the resident
scope. An interrupted, rejected or ambiguous experiment retains that claim.
Restarting a process or recording another run of the same task does not silently
repeat it. A new source/input revision is a new task; a changed evaluation
contract is a new evaluator revision. Neither label should be changed just to
retry a failed experiment. Unfinished work requires inspection and explicit host
recovery, not automatic replay.

No eligible observation returns `{observation: null, cycle: null}` without
generation, evaluation or a new journal. Otherwise `observation` is the selection
snapshot and `cycle` reports the existing activation/rejection/conflict outcomes.
Fresh independent confirmation, receipt completeness, agenda conflict checks,
exact candidate hashes and rollback remain the existing cycle's responsibility.

## Persistence and inspection

Observations and per-task attempt claims use SQLite beside the cycle journal.
Schema version 2 adds these tables. Reads of version 1 return no observations
without modifying its bytes; the next write upgrades in one transaction. Older
SDKs that only recognize version 1 cannot open the upgraded database.

`store.observations({after, limit})` pages oldest first with a stable ordinal,
exclusive `after` cursor and limit 1–100 (default 20). Each record includes
`attemptedCycleId`; a reference to an unfinished experiment does not establish
a live worker. Absent storage returns no observations without creating files.

The CLI's existing explicit `resident learn <host.learning.mjs> --trust` accepts
a discovery host returning `evaluators`. `namzu resident learning --observations`
shows outcomes and claimed experiments; `--after` and `--limit` page the list.
Compact previews include the observation reason and recorded paired pass counts. Full traces remain in structured inspection. The `started` journal event records the selected `observation.ordinal`; the store validates and claims that reference in the same transaction.
