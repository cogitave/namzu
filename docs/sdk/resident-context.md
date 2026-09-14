---
type: Reference
title: Resident step context
description: Stable resident guidance and captured continuation state through the existing SDK prompt contribution registry.
resource: packages/sdk/src/prompt/resident-step.ts
tags: [sdk, agents, context, continuity]
status: draft
---

# Resident step context

For on-demand learned guidance, use `createResidentStepContext(options)`. Mount
**both** its `tools` and `contributions` on the admitted run. It accepts
`ResidentStepContextOptions`: the options below plus a required synchronous
`authorizeLearningRead(context): boolean` callback. Only `true` authorizes a read;
the host checks the run identity and that admission is still active. The bundle
does not enforce a tenant boundary without that host check.

```ts
import {
  createResidentStepContext, PromptContributionRegistry, ToolRegistry,
  type ResidentStepPromptOptions, type RunId,
} from '@namzu/sdk'

export function contextForAdmission(
  options: ResidentStepPromptOptions, runId: RunId, isActive: () => boolean,
) {
  const bundle = createResidentStepContext({
    ...options,
    authorizeLearningRead: context => context.runId === runId && isActive(),
  })
  const tools = new ToolRegistry()
  for (const tool of bundle.tools) tools.register(tool)
  const promptContributions = new PromptContributionRegistry()
  for (const contribution of bundle.contributions) promptContributions.register(contribution)
  return { tools, promptContributions }
}
```

`ResidentStepContextBundle` contains a short metadata catalogue and the
`read_resident_skill({name})` tool. The model chooses applicability; the SDK does
not guess from keywords, call another model, or treat acceptance on one task
family as evidence of general usefulness. Each read returns the complete bounded
skill and its evidence; it grants no permissions and performs no filesystem or
network operations. Unknown names, failed authorization and unverified source
bindings disclose no instructions. A cancelled call does not select a skill.

Only task guidance appears in this catalogue. Learned
[exploration policies](exploration-policies.md) are excluded, and guessing their
names through `read_resident_skill` does not disclose their bodies. A learning
host explicitly projects them into its explorer instead.

Create a fresh bundle for each admission and keep its tools out of other runs.
Selection is not persisted. Descriptions are limited to 160 Unicode code points
each (16 skills maximum); full descriptions are retained in the read result.
Selected bodies use the remaining part of the existing 12,000-character learning
budget after profile entries. A single tool read has a separate 12,000-character
cap. Individual entries are never partially injected. The catalogue is additional
context; these limits do not cap the complete model request.

The `resolveLearningSources` callback is checked at read time and before every
following request containing selected guidance. Withheld guidance is accompanied
by a notice to recheck current evidence. Earlier tool results remain in history:
this is current-request invalidation, not deletion of model-visible history.

The [transfer diagnostic](../../research/resident/learning-transfer.md) compares
fixed learned guidance with fresh unrelated tasks and exercises this path in
the real CLI/TUI. It also records a case where the model still loaded unrelated
guidance; disclosure is not a semantic applicability guarantee.

The older factory below retains eager disclosure for existing SDK hosts.

`createResidentStepContributions(options)` builds context for one admitted
[resident step](resident-agents.md). It returns two `PromptContribution` objects
for the existing `PromptContributionRegistry`. Register them on the registry
passed to `query` or `drainQuery`; other host contributions can use that same
registry.

`ResidentStepPromptOptions` requires `state: ResidentState` and
`outputInstructions: string`. Optional fields are the admission's approved
`learning: ResidentLearningState`, `history: ResidentHistoryScope`, host-loaded `skillsContext: string`, and
`readOnly: boolean` (default false).

```ts
import {
  PromptContributionRegistry,
  createResidentStepContributions,
  type ResidentLearningState,
  type ResidentState,
} from '@namzu/sdk'

export function promptForStep(state: ResidentState, learning?: ResidentLearningState) {
  const contributions = new PromptContributionRegistry()
  for (const contribution of createResidentStepContributions({
    state,
    learning,
    readOnly: true,
    outputInstructions: 'Return the host receipt with a disposition and retained evidence.',
  })) {
    contributions.register(contribution)
  }
  return contributions
}
```

The `static` contribution (`namzu.resident-step.guidance`) carries concise work
and evidence standards, authority boundaries, optional read-only guidance, and
the host's output instructions. The `dynamic` contribution
(`namzu.resident-step.continuation`) carries identity, the whole objective, prior
summary, admission number, the complete pending `wakeEvidence`
batch, approved learning and supplied skills. Wake entries remain in commit
order; later input does not automatically supersede an earlier failure. The
guidance asks the step to resolve contradictions and retain still-relevant
evidence in its next summary before settlement consumes the batch.
Without a batch it supplies the single `wakeReason`; with a batch the latest
reason is not repeated separately, avoiding duplicate context.
Changing that snapshot leaves the static prefix unchanged when the host's
guidance and output contract remain the same.

When the host mounts [resident recall tools](resident-recall.md), pass their
source's scope as `history`. The factory rejects a different tenant, resident or
pursuit, adds static retrieval guidance and captures the upper revision in the
dynamic snapshot. Changing that revision does not change the static prefix.
The reference survives compaction; historical text is fetched only when a tool
is called. Do not pass this option without mounting and authorizing the tools.

After mounting the separately authorized [retained tool evidence tools](retained-tool-evidence.md),
set `toolEvidence: true` to include stable guidance for recovering exact earlier
tool text across settled invocations. It does not attach output eagerly or
change the authority captured by `history`.

The query prompt cache validates the rendered static text, not only contribution
IDs. Replacing a registry, skill body or host contract under an existing name
cannot silently reuse old instructions. Full-prompt cache validation renders
once per lookup; it does not skip local rendering on a cache hit. Dynamic and
turn content do not invalidate the segmented static prefix.

Both contributions capture text when the factory is called. Later mutation of
the supplied objects cannot change an admitted invocation's context. Create
fresh contributions for each new admission; register each pair once per
registry. The SDK's `query` renders static and dynamic contributions at invocation
start and includes both in every iteration. They form the leading system floor
preserved by compaction. A `turn` contribution is instead rendered before each
model request and stays outside durable history; reserve it for state that must
change within an invocation.

The saved summary is identified as a report of previous work. Guidance asks the
model to retain useful evidence and unfinished work, check mutable state when
needed, and recover missing evidence with reads rather than replaying effects.
Follow-up interpretation separates the requested subject from the requested
time: an accepted correction may identify a subject without replacing its
original observation. When an unnamed reference has multiple plausible subjects,
the model is instructed to present labelled alternatives or request clarification,
rather than choose from retrieval order or a summary's mere mention.
Current-state questions, including short continuations, require a fresh permitted
observation. The latest archived record remains **last observed**, not verified
current state. If fresh evidence is unavailable, guidance asks for an explicit
limitation and a non-complete disposition for the unfinished current-state task.
These are model instructions, not a semantic verifier or an additional query
planner; the host's answer validation remains responsible for enforced outcomes.

The [resident interpretation experiment](../../research/resident/interpretation.md)
separately captures historical evidence in actual provider requests and the
model's answers across three isolated CLI admissions. It reproduces mistaken
subject selection and stale current-state answers before comparing the updated
guidance on the same fixtures. Retrieval authority and byte/context bounds are
unchanged. No claim of universal ambiguity resolution follows from these trials.

A bounded step can leave useful work for the next admission; completion refers
to the whole authorized objective. The host supplies its own response format
and owns answer validation and durable settlement.

[Approved learning](resident-learning.md) uses `projectResidentLearning` with a
12,000-character projection bound and all task skills present in that approved
snapshot selected; exploration policies are withheld. The projection reports omitted entries and never emits a
partial learning entry. That limit applies to learning, not to the entire prompt
or host-supplied skill context.

The factory performs no I/O, discovers no instructions and grants no permissions.
Continue passing the host's `projectInstructionContext` and authorization
configuration through their existing runtime paths. The `readOnly` option only
describes an enforced boundary; it must match the host's actual permissions.
Its guidance permits completion of read-only work and does not impose the
interactive coding agent's plan reply or pause-for-approval workflow. Existing
coding doctrine exports and ordinary prompt construction are unchanged.
