---
type: Reference
title: Learning
description: The learning module of the SDK, which belongs to every Namzu host and not to residents: observations, the learning cycle, its durable store, the leak tripwire, the experience library, the built-in generator, the names it exports and the old resident-prefixed names kept as deprecated aliases.
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
| Built-in generator, one surface | `generator.ts` | `proposeLearningCandidate`, `resolveLearningSurface`, `learningExperienceFromCycle`, `LearningModel` |
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
- `edits`, the typed ledger: `surface`, `change` and a `verdict` of
  `helped`, `hurt`, `no observed effect` or `confounded`.
- `lessons`: a `cue` (the shape of the situation), the `lesson`, `evidence`
  references, a `confidence` of `high`, `medium` or `low`, and the reason for it.

Two rules keep the record honest. When a candidate has more than one edit row
(two rows for the same surface count too), the outcome belongs to the whole
change, so every row without `isolated: true` (an edit tried alone) is stored as
`confounded`. `isolated` is trusted from the caller: nothing checks that an
ablation actually ran. A lesson that cites edits (`edits: [index]`) is capped at
`medium` when any of them is confounded and at `low` when all are, and its
reason says it was narrowed. A lesson that cites no edits is treated as resting
on all of them.

`evaluatorRevision` is stamped on every entry and required at retrieval, so a
cycle judged under a new evaluator starts with an empty history. The store does
not stop a domain from moving to a new evaluator; a host that wants that
refused has to enforce it.

`retrieve({ domain, evaluatorRevision, beforeOrdinal })` returns entries of
that domain and evaluator revision recorded before `beforeOrdinal`, newest
first. It never crosses a domain, an evaluator revision, or reaches an entry
at or after the reader's own. `nextOrdinal()` gives the point just after
everything recorded in this store's scope. `leakGuard` is required on both
`record` and `retrieve` (pass `{}` to apply only the built-in markers and secret
shapes). Both walk every string the entry holds, including the edit surfaces, the
evaluator revision, the artefact name and the evidence, and throw
`LearningLeakError` without repeating the text. Retrieval scans again, so an
entry recorded under a looser guard is not served to a generator.

## Built-in generator

`proposeLearningCandidate` is the first generator Namzu ships: one step on one
surface. It does not run a cycle and does not judge anything. The host passes
the observations of a domain, the earlier cycles of the same domain and
evaluator (from the experience library), the active skill, a `leakGuard` and a
`LearningModel`, which is one function from a request to `{ text, tokens,
costUsd }`. The host picks the model and counts the spend; the SDK never
opens a provider for it.

What it does, in order:

1. Scans the observations, the earlier cycles and the baseline through the leak
   tripwire. A hit throws `LearningLeakError` before any model call.
2. Asks the model for one revision of the skill (`description`, `body` and a
   list of `edits`, each naming the `surface` it touches). The prompt puts the
   data first inside tags that carry a fresh random marker, states what to do
   and why, and names no other product or vendor. The skill keeps its name.
3. Checks the answer against the editable surface. Every edit's `surface` must
   be on the surface, and the wording must stay clear of the safety floor
   (permission review, protected paths, the always-refused command patterns,
   the learning code) and must not tell a reader to start over. A problem is
   reported back to the model once, naming the part that failed; a second
   failure returns `{ status: 'refused', offSurface }`. The refusal names the
   parts, never the text.
4. Returns `{ status: 'proposed', candidate, edits }`. Each model call is
   offered to `recordUsage` as one receipt, so the cycle counts it.

The surface is an allowlist. `resolveLearningSurface()` returns the instruction
skill and nothing else. Naming a safety-floor part
(`LEARNING_FLOOR_COMPONENTS`) or an unknown kind throws; no configuration makes
the floor editable.

`learningExperienceFromCycle` turns a finished cycle into the experience entry
the next proposal reads. An activated cycle is `adopted` and its edit `helped`;
a rejected one is `rejected`, with the edit `hurt` when the review found a
regression and `no observed effect` otherwise. Inconclusive, failed and
cancelled cycles leave nothing. With several edits the verdicts become
`confounded`, as the library already rules.

The candidate then goes through `runLearningCycle` unchanged: paired
verification, the protection plan, a fresh confirmation round and activation by
exact revision. `@experimental`, like the rest of the module.

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
