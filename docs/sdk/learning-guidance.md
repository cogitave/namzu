---
type: Design
title: Learning guidance
description: Revisioned, evidence-backed guidance a learning target has earned, evaluated promotion, reversible activation, source-dependent skills, bounded projection and the carry-over of earlier stores.
resource: packages/sdk/src/learning/guidance.ts
tags: [sdk, learning, guidance, storage]
status: draft
---

# Learning guidance

Guidance is the behavioral adaptation learning produces: a self-description,
preferences and evaluated reusable skills, kept as persisted context. It is not
model-weight training, autonomous authority or evidence of general intelligence.
Everything here is an optional SDK capability; the SDK installs no provider,
background loop or executable-code activation. The [learning cycle](learning-cycle.md)
connects host-owned candidate generation and evaluation to the activation
primitives on this page.

## The store

`DiskLearningGuidance(directory, { tenantId, agentKey }, options?)` keeps one
scope's guidance as immutable numbered revisions under `<directory>/revisions/`.
A revision is published exclusively (a hard link), so two processes cannot both
commit the same number, and a stale writer gets `LearningGuidanceConflictError`
instead of overwriting. Revision files are never removed, which is what lets one
skill be rolled back to an earlier revision. Trusted local filesystems only.

`read()` returns the latest `LearningGuidanceState` (`tenantId`, `agentKey`,
`revision` and the optional `learning`), `readRevision(n)` one committed
revision, `create()` the empty first revision and `open()` the current one,
creating it when none exists. Every change takes the snapshot it was based on:
a change against any other revision, or against learning that moved, fails.

Nothing else is stored here. The experiment journal and its artifacts are the
separate [learning records](learning-storage.md); the two are different
authorities for different facts.

### Guidance an earlier version kept

Earlier versions kept the same revisions inside another record format, under
`<root>/<tenant>/<key>/agenda/`. Pass `adoptFrom: earlierGuidanceDirectory(root,
{ tenantId, agentKey })` and the first use of the new store copies every
revision it finds there, with its revision number, then writes `adopted.json`
beside them. The earlier files are only read: they are not changed or removed,
so an older version keeps working on them. The copy is refused, and no marker is
written, when the earlier history has a gap or belongs to another tenant or
scope key. Two processes that first use the store together both end at the same
head. Revision numbers are kept because the learning journal names the revision
an activation created, and an undo restores from the one before it.

## Correcting the profile

`updateProfile(expected, LearningProfileUpdate)` accepts an optional
self-description `identity`, a patch list of `preferences` and
`LearningEvidence`. Evidence has nonempty `key`, `source` and `reason`; the host
validates its provenance and authority. The SDK does not verify a cited external
artifact merely because its key is supplied.

Each preference patch contains `key`, `value` and `supersedes`. For a new key,
`supersedes` is null; for a correction it must equal the currently stored
preference's evidence key. Duplicate patch keys, stale corrections and reusing
evidence still retained in the active learning state are refused. This last
check is not a permanent global evidence-ID ledger; the host owns stable source
identity and must not recycle old IDs for unrelated assertions.

The result is a new immutable `LearningState`: its increasing revision, the
optional self-description with evidence, preferences, active learned skills and
`lastChange`. Limits are 4,000 characters for the self-description, 32
preference keys with 1,000-character values, and 16 active skills. Names use
lowercase letters, digits, underscores and hyphens. Preferences not mentioned
in a patch are retained.

## Evaluated guidance and rollback

`LearningSkillCandidate` contains `name`, `description` and instructional
`body`, capped at 64, 1,000 and 4,000 characters. Surrounding whitespace is
normalized. `hashLearningSkill(candidate)` hashes the normalized tuple with
SHA-256; optional source bindings extend it, so changing content or a declared
source revision changes its approval identity.

`promoteSkill(expected, candidate, LearningSkillEvaluation, evidence)` binds both
verification rounds' `candidateRevision` to that digest and `baselineRevision`
to the currently active skill's digest (`none` when no skill of that name is
active), then invokes `reviewHarnessCandidate`.

`LearningSkillEvaluation.protection` is required: it names disjoint verification
and confirmation preservation task IDs selected by the host before generation,
and both rounds must contain successful paired baseline and candidate results
for every declared control. The same gate applies to direct `promoteSkill`
calls, not only learning cycles; an omitted plan is refused (see the
[preservation contract](harness-verification.md#declared-preservation-tasks)).
Only `accept` changes durable learning; rejection or inconclusive evidence leaves
the guidance unchanged, and a later stale revision does not rerun the model or
the evaluator. Each round is limited to 64 tasks and 128 trials per side.

The review requires at least five tasks with two paired trials each,
trace-linked improvement, no observed regression or ambiguous measurement, and
a same-sized fresh confirmation round with limited task reuse. Tasks that fail
on both sides may remain failing. The host owns task selection, isolation,
scoring, attribution and complete cost measurement; a candidate's own success
claim is not an evaluation.

`LearnedSkill` stores the normalized content, its hash, the source evidence, the
baseline and candidate hashes, the number of verification and confirmation
tasks, and a digest of the supplied evaluation. Full traces belong in the
host's retained evaluation artifacts. Skill code is neither compiled nor
executed by this surface, and promotion grants no tool, file, network, model,
account or messaging authority.

`rollbackSkill(expected, name, fromRevision, evidence)` restores that named
skill from an existing immutable revision, or removes it when that revision had
none. This appends a new revision; it never decreases a revision or erases
history, and the current preferences, self-description and other skills stay.

## Source-dependent guidance

A candidate may declare `sources: [{ key, revision }]`: up to eight unique,
nonempty host-owned source identities and their revisions. The host supplies and
checks those bindings; a model-generated digest is not source verification.
Bindings are normalized, sorted by key, included in the approval hash and
retained through generation, evaluation, activation, storage and rollback.

`projectLearning` accepts an optional `sources` array of current host
observations. Every dependency must match exactly. A missing observation yields
`unverified-source`, a different revision `changed-source`; such skills are
counted in `omitted` and listed in `withheldSkills`, and **their bodies are not
projected**. The stored skill is preserved for inspection, and other skills and
profile entries stay eligible. A matching revision establishes only that the
declared dependencies match, not that the guidance is correct.

The CLI treats a `workspace-file:<relative/posix/path>` key with a lowercase
SHA-256 byte revision as a file dependency. Conversations in a project are
started only with guidance that has no source bindings.

An optional [exploration purpose](exploration-policies.md) separates learned
experiment-selection policies from ordinary task guidance. It is covered by the
content digest and requires an explicit matching projection.

## Projecting guidance

`projectLearning(state, { maxChars, skillNames })` returns a `LearningProjection`:
newline-separated JSON entries, the revision, the included skill names and an
omission count. The character budget is required and bounded to 0–64,000
UTF-16 code units. The self-description and preferences precede explicitly
selected skills. Oversized entries are omitted whole, and a large entry does
not prevent a smaller later one from fitting. Unknown selected skills count as
omitted, including when no learning state exists; unselected skills are never
injected. This is a character cap, not a provider-token or monetary budget.

```ts
import { DiskLearningGuidance, type TenantId, projectLearning } from '@namzu/sdk'

const directory = '/path/to/learning/guidance'
const tenantId = 'tenant-1' as TenantId
const guidance = new DiskLearningGuidance(directory, { tenantId, agentKey: 'project' })
const state = await guidance.open()
const projection = projectLearning(state.learning, {
  maxChars: 3000,
  skillNames: ['normalize-input'],
})
```

For what is built, what is opt-in and experimental, and what is still missing
(fan-out and blind selection among several candidates), see the
[status in the learning cycle page](learning-cycle.md#status-and-what-is-missing).
The older [readiness study](../../research/resident/rsi-readiness.md#verified-status-2026-10-26)
is historical: it predates the removal of the resident feature and its scripts no longer run.
