---
type: Reference
title: Learning
description: The learning module of the SDK, which belongs to every Namzu host and not to residents: observations, the learning cycle, its durable store, the names it exports and the old resident-prefixed names kept as deprecated aliases.
resource: packages/sdk/src/learning/cycle.ts
tags: [sdk, learning, evaluation, observations]
status: draft
generated: { by: process:claude-code, at: 2026-10-26T00:00:00Z }
---

# Learning

Learning is a feature of the whole kernel. A conversation, a scheduled run or a
resident can all produce the failures it starts from, and all can read what it
approves. The code lives in `packages/sdk/src/learning/` and its names no longer
say resident.

| Part | File | Main names |
| --- | --- | --- |
| Guidance, state and projection | `skill.ts` | `LearningSkillCandidate`, `LearningState`, `hashLearningSkill`, `projectLearning` |
| One experiment | `cycle.ts` | `runLearningCycle`, `LearningCycleOptions`, `LearningCycleResult` |
| Durable records | `store.ts` | `SqliteLearningStore`, `runStoredLearningCycle`, `runStoredLearningFromObservations` |
| Host-scored observations | `observation.ts` | `LearningObservation`, `LearningObservationRecord`, `LearningTarget` |

Behaviour is unchanged by the move. The cycle still needs a host that supplies
how a candidate is generated and how it is judged, still activates only the
exact revision that passed paired verification and fresh confirmation, and is
still `@experimental`. The detail pages are [Resident learning cycle](resident-learning-cycle.md),
[Durable learning records](resident-learning-storage.md),
[Learning discovery](resident-learning-discovery.md) and
[Approved learning](resident-learning.md); their file names keep the word
resident because the activation target today is a resident's agenda
(`LearningCycleOptions.agenda`).

## Old names

Every name that carried `Resident` still works and is the same value or type as
the new one. Each is marked `@deprecated` and is removed in the next major
release.

| Old | New |
| --- | --- |
| `runResidentLearningCycle` | `runLearningCycle` |
| `SqliteResidentLearningStore` | `SqliteLearningStore` |
| `runStoredResidentLearningCycle` | `runStoredLearningCycle` |
| `runStoredResidentLearningFromObservations` | `runStoredLearningFromObservations` |
| `hashResidentSkill`, `projectResidentLearning` | `hashLearningSkill`, `projectLearning` |
| `ResidentSkillCandidate`, `ResidentLearnedSkill`, `ResidentProfileUpdate`, `ResidentSkillEvaluation` | `LearningSkillCandidate`, `LearnedSkill`, `LearningProfileUpdate`, `LearningSkillEvaluation` |
| `ResidentLearning<X>` (state, evidence, cycle and store types) | `Learning<X>` |

## Retention

`SqliteLearningStore.pruneObservations(shouldDrop)` removes unclaimed
observations the host chooses to drop. An observation a cycle has claimed is
never removed. The store keeps no clock, so the host decides from the record;
the CLI uses the age of the conversation the observation refers to.

See [Learning in the CLI](../cli/learning.md) for the commands and the
conversation feed.
