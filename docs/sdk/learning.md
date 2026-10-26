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
| Experience library and edit ledger | `experience.ts`, `experience-store.ts` | `SqliteLearningExperienceStore`, `LearningExperienceEntry`, `normalizeLearningExperience`, `selectLearningExperience` |
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

## Leak tripwire

Guidance is built from retained evidence and then judged by an independent
evaluation. If the evidence, or the guidance built from it, carries what the
evaluation holds back, the judgement measures nothing. `runLearningCycle`
therefore checks three things before it builds on them: the failure evidence
before any stage or journal entry, the exploration observations before
generation, and the generated candidate (name, description, body, sources)
before it is hashed, journaled or evaluated.

A hit refuses the cycle with status `failed`, a reason that says it is a leak
and not a false positive, and `result.leak`, a list of
`{ kind, subject, rule }`. The matched text is never repeated: not in the
reason, the result or the journal, and a refused candidate is not returned.

The kinds of evaluator-side material, set per experiment with
`LearningCycleOptions.leakGuard`:

- `paths`: globs for evaluator-owned locations (`*` stays in a segment, `**`
  crosses them). Checked on a candidate's source keys and on location-like
  words inside text.
- `canaries`: random strings you plant inside evaluator data
  (`createLearningCanary()`). One sighting is proof, whatever the case,
  spacing, zero-width characters, hex (either case), or base64 and base64url
  at any of its three alignments inside a larger blob (line wrapping is
  ignored). The built-in secret shapes are also tested with zero-width
  characters removed. The active skill baseline is scanned too, before any
  stage. Other encodings (gzip, rot13, split across fields) are not detected.
  `namzu learn` passes no `leakGuard`, so the CLI applies only the built-in
  markers and secret shapes; path globs, canaries and protected contents need
  a host that calls the SDK and supplies them.
- `markers`: extra wording only evaluator output carries.
- `protectedContents`: verbatim protection-task prompts or expected answers
  (at least 12 characters; whitespace and case are ignored).
- `secrets`: literal secret values to keep out.

Built in and always on, with no configuration: wording of a grader or judge
verdict, an answer key or expected answer, a hidden rubric or held-out test
cases, and the shapes of private keys, API keys, cloud keys, platform tokens
and bearer credentials. Evidence that mentions one of these is refused, which
is the point: such text should not steer guidance.

`scanForLearningLeak` and `assertNoLearningLeak` (throws `LearningLeakError`)
expose the same check to a host that builds evidence itself. An empty scan is
not a proof that nothing leaked; the disjoint protection tasks and the
host-owned evaluator remain the first defence.

## Experience library

`SqliteLearningExperienceStore` keeps what each finished cycle tried and what
came of it, in its own database beside the observations. A generator that
reads it learns across cycles; nothing in the cycle depends on it yet.

One entry per cycle, immutable (recording the same cycle again with identical
content returns the stored entry, with different content is refused):

- `domain`, the kind of task, and `evaluatorRevision`, the evaluator that
  judged it. Both are pinned on the entry.
- `decision` (`adopted` or `rejected`), the `reason`, and the full artefact as
  proposed with its `candidateRevision`. The artefact is stored whole, never
  summarised.
- `edits`, the typed ledger: `component`, `change` and a `verdict` of
  `helped`, `hurt`, `no observed effect` or `confounded`.
- `lessons`: a `cue` (the shape of the situation), the `lesson`, `evidence`
  references, a `confidence` of `high`, `medium` or `low`, and the reason for it.

Two rules keep the record honest. When a candidate changed more than one
component, the outcome belongs to the whole change, so every row without
`isolated: true` (an edit tried alone) is stored as `confounded`. A lesson that
cites edits (`edits: [index]`) is capped at `medium` when any of them is
confounded and at `low` when all are, and its reason says it was narrowed.

`retrieve({ domain, evaluatorRevision, beforeOrdinal })` returns entries of
that domain and evaluator revision recorded before `beforeOrdinal`, newest
first. It never crosses a domain, an evaluator revision, or reaches an entry
at or after the reader's own. `nextOrdinal()` gives the point just after
everything recorded. `record` runs the leak tripwire over the entry (reason,
artefact, edits, lessons) with an optional `leakGuard` and throws
`LearningLeakError` without repeating the text.

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
