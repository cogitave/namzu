---
type: Design
title: Resident learning experiment
description: Evidence-backed behavioral revisions, evaluated guidance, reversible activation and bounded admitted context.
resource: packages/sdk/src/manager/resident/learning.ts
tags: [sdk, agents, continuity, learning]
status: draft
---

# Resident learning experiment

This completes the five-stage [resident SDK experiment](resident-agents.md)
with versioned self-description/preferences and evaluated reusable guidance.
It is behavioral adaptation through persisted context, not model-weight
training, autonomous authority, or evidence of general intelligence. All stages
remain optional SDK capabilities; CLI integration and service hosting are separate.

## Research and existing kernel mechanisms

[Reflexion](https://arxiv.org/abs/2303.11366v4) uses textual feedback retained
across attempts instead of modifying model weights. This motivates preserving
corrections and feeding them into later work. Namzu does not equate an extracted
reflection with verified evidence or independently reproduce that paper's scores.

[Voyager's implementation](https://github.com/MineDojo/Voyager/blob/55e45a880755d0c8c66ca7fb5fe7962ac8974f89/voyager/voyager.py)
retains reusable skills after a task-success check. Its critic is not a guarantee
against regressions on other tasks. Here promotion reuses Namzu's existing
[paired harness verification](harness-verification.md), including fresh confirmation;
there is no second experimental score threshold replacing it.

[Hermes' file-role separation](https://github.com/NousResearch/hermes-agent/blob/8c74118c4a0c332a6bc57d2509147bad0e6ee864/website/docs/user-guide/which-file-does-what.md)
distinguishes identity from learned user information. Our resident's original
`identity` remains its immutable host mandate. A versioned self-description is
an overlay, not a way to rewrite that mandate or tool permissions.

The ordinary `SkillRegistry` continues to own file loading and invocation
policy. Resident guidance is stored as normalized immutable text, not a mutable
file path, installed plugin, or executable asset. `PromoteMemory` remains a
separate best-effort extraction hook; it is not the activation transaction.

## Correcting the profile

`DiskResidentAgenda.updateProfile(expectedAgenda, ResidentProfileUpdate)`
accepts an optional self-description `identity`, a patch list of `preferences`,
and `ResidentLearningEvidence`. Evidence has nonempty `key`, `source`, and
`reason`; the host validates its provenance and authority. The SDK does not
verify a cited external artifact merely because its key is supplied.

Each preference patch contains `key`, `value`, and `supersedes`. For a new key,
`supersedes` is null; for a correction it must equal the currently stored
preference's evidence key. Duplicate patch keys, stale corrections and reusing
evidence still retained in the active learning state are refused. This last
check is not a permanent global evidence-ID ledger; the host owns stable source
identity and must not recycle old IDs for unrelated assertions.

The result is a new immutable `ResidentLearningState` in the same agenda CAS.
It records its increasing revision, optional self-description with evidence,
preferences, active learned skills and `lastChange`. Limits are 4,000 characters
for self-description, 32 preference keys with 1,000-character values, and 16
active skills. Names use lowercase letters, digits, underscores and hyphens.
Existing preferences not mentioned in a patch are retained.

The original agenda and pursuit identity are unchanged. Writes are rejected
while any pursuit is running, and stale agenda revisions cannot commit. Thus a
host cannot silently change the learned context of an already admitted step.
Old profile snapshots remain available through `readRevision(agendaRevision)`.

## Evaluated guidance and rollback

`ResidentSkillCandidate` contains `name`, `description`, and instructional
`body`, capped at 64, 1,000 and 4,000 characters respectively. Leading/trailing
whitespace is normalized. `hashResidentSkill(candidate)` hashes the normalized
three-field tuple with SHA-256; changing any field changes its approval identity.

`promoteSkill(expectedAgenda, candidate, ResidentSkillEvaluation, evidence)`
binds both verification rounds' `candidateRevision` to that digest and
`baselineRevision` to the currently active skill's digest, or `none` when no
skill with that name is active. It then invokes `reviewHarnessCandidate`.
Only `accept` changes durable learning; rejection or inconclusive evidence
leaves the agenda unchanged. A later stale CAS does not rerun the model or the
evaluator. Each round is limited to 64 tasks/128 trials per side.

The existing review requires at least five tasks with two paired trials each,
trace-linked improvement, no observed regression or ambiguous measurement, and
a same-sized fresh confirmation round with limited task reuse. It is not an
all-cases-pass requirement: tasks which fail on both sides may remain failing.
The host must additionally enforce any mandatory application cases and resource
limits it needs. It owns task selection, isolation, scoring, attribution and
complete cost measurement before calling promotion. A candidate's own success
claim is not an evaluation.

`ResidentLearnedSkill` stores the normalized content, its hash, source evidence,
baseline/candidate hashes, counts of verification/confirmation tasks, and a
digest of the supplied evaluation. Full traces belong in the host's retained
evaluation artifacts; a digest alone does not reconstruct or certify them.
Skill code is neither compiled nor executed by this surface. Promotion grants
no tool, file, network, model, account or messaging authority.

`rollbackSkill(expectedAgenda, name, fromAgendaRevision, evidence)` restores
that named skill from an existing immutable revision. If the old revision had
no such skill, it removes the current skill. This appends a new learning revision;
it never decreases a revision or erases history. Current preferences,
self-description and other skills remain intact. Recovery from changed
requirements is an explicit host decision; regression does not start a hidden
monitor or rollback service.

## Admitted context

Enable `new ResidentHost(agenda, step, { learning: true })` to receive approved
learning in the callback's third `ResidentStepContext` argument. Its
`agendaRevision` identifies the immutable snapshot used to authorize admission.
Its optional `learning` is a frozen copy of that snapshot's learning state.
The same snapshot is bound through `executionAt`, including when learning was
initially absent, so a racing first profile activation cannot be missed silently.

Default hosts do not inject learned context. Existing two-argument
`ResidentPursuitStep` callbacks still work; `ResidentContextualStep` describes
the three-argument surface. Custom agenda backends require atomic `executionAt`
support when enabling this option. The callback decides how to assemble the
provider request from this data; the kernel does not overwrite its system policy.

`projectResidentLearning(state, { maxChars, skillNames })` creates a
`ResidentLearningProjection`: newline-separated JSON entries, revision,
included skill names and omission count. The character budget is required and
bounded to 0–64,000 UTF-16 code units. Self-description and preferences precede
explicitly selected skills. Oversized entries are omitted whole; a large entry
does not prevent a smaller later one from fitting. Unknown selected skills
count as omitted, including when no learning state exists. Nonselected skills
are not silently injected. This is a character cap, not a provider-token or
monetary budget.

```ts
import {
  ResidentHost, projectResidentLearning,
  type ResidentAgendaStore, type ResidentLearningProjection,
} from '@namzu/sdk'

function inspectAdmittedLearning(
  agenda: ResidentAgendaStore,
  inspect: (projection: ResidentLearningProjection) => void,
) {
  return new ResidentHost(agenda, async (_pursuit, _signal, context) => {
    inspect(projectResidentLearning(context.learning, {
      maxChars: 3000, skillNames: ['normalize-input'],
    }))
    return { kind: 'complete', summary: 'Inspected admitted context.' }
  }, { learning: true })
}
```

## End-to-end evidence

After building the SDK (and Zen driver for the live smoke):

```bash
node research/resident/lifecycle.mjs
node research/resident/learning-live.mjs
node research/resident/learning-live.mjs --live
```

The lifecycle script executes 80 real `runExperiment` cases using a deterministic
parser fixture. A candidate instruction trims values; a bad candidate uppercases
them. Verification and confirmation use different cases/conditions, and
attribution derives from recorded outputs. The accepted candidate improves
8/20 baseline passes to 20/20 across both rounds. The regressing candidate falls
from 20/20 to 0/20 and is rejected without a state write. These are controlled
fixture outcomes, not an LLM benchmark or learned policy generalization.

One initial pursuit continues for two steps from its saved summary, without a
second user prompt. Host-supplied profile correction and approved guidance
reach admitted context after reopening. Rollback removes the skill while
preserving the corrected preference; one bounded child checks the next context.
A quiet window makes no delivery call; opening it produces one local in-memory
receipt. Terminal pursuits and the message are then archived and historical
state remains readable. The script makes zero model or network calls.
Evidence: `research/resident/results/2026-09-11-lifecycle.json`.

A separate live smoke made two Muse Spark calls at low effort, reporting
1,098 tokens total. The first admission projected an English preference and
returned `Ready`; after explicit correction and reopening, the second projected
Turkish and returned `hazır`. Both ended with `end_turn`, retained the prior
summary, and the final idle check made zero calls. Evidence:
`research/resident/results/2026-09-11-learning-live.json`. This proves the tested
preference reached real SDK inference; it does not prove self-generated learning.

All five SDK stages now have executable experiments. This does not complete an
always-on end-user product: service supervision, permission/consent UI, external
delivery adapters and immutable-history storage compaction remain application
or future storage work. [Archival](resident-retention.md) frees active slots but
does not bound total disk history. The measured initiative selector remains
opt-in because its earlier evaluation exposed premature stopping.
