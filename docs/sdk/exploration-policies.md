---
type: Design
title: Evaluating exploration policies
description: Purpose-bound learned instructions for the procedure that acquires evidence, evaluated separately from task knowledge.
resource: packages/sdk/src/manager/resident/learning.ts
tags: [sdk, resident, learning, exploration]
status: draft
---

# Evaluating exploration policies

A `ResidentSkillCandidate` may declare `purpose: 'exploration'`. Its body then
describes how an explorer chooses experiments. A host can measure whether those
instructions improve later acquisition of useful evidence, using the existing
[learning cycle](resident-learning-cycle.md) and independent evaluator. This is
different from storing a rule learned about one particular environment.

`runResidentLearningCycle` accepts the same optional `purpose`. The host declares
it before generation; generation/exploration receive the admitted value. A candidate
with a different effective purpose is refused before evaluation. An existing skill
cannot be repurposed under its current name, including through direct promotion.
Use a distinct name and new evaluation for another purpose.

Omission and explicit `task` mean ordinary task guidance. Existing hashes stay
unchanged. Exploration purpose is bound into `hashResidentSkill`, so copying its
proof while changing it into task guidance fails validation. Normalization,
immutable agenda revisions, SQLite artifacts, acceptance and rollback retain
the field through their existing paths.

`projectResidentLearning(state, { maxChars, skillNames })` selects task guidance.
An explicit `purpose: 'exploration'` selects exploration policies instead. A named
skill for another purpose appears in `withheldSkills` with reason
`different-purpose` and empty `sourceKeys`; it counts as omitted. Matching purpose
does not bypass source freshness checks or the size cap. Profile identity and
preferences follow the existing projection behavior in either mode.

CLI resident steps use ordinary task projection, so accepted exploration policies
do not become instructions for unrelated work. A learning host must explicitly
project an accepted policy into its explorer. Projection does not register tools,
execute generated code, change permissions or schedule learning automatically.

For a meaningful policy comparison, hold tools, model, predictor and acquisition
limits fixed; use unseen environments and keep test inputs out of the explorer.
Score the downstream result from actually acquired observations, rather than the
explorer's claim that its policy improved. Declare preservation tasks and independent
confirmation before proposing the policy. Record incomplete usage and failed runs
without silently substituting new trials.

The [research study](../../research/resident/exploration-policy.md) exercises this
contract through the built CLI with Muse low. A policy update is a bounded change
to learning instructions. A successful experiment alone does not establish recursive
self-improvement of the full learning program or general intelligence.
