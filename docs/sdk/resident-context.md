---
type: Reference
title: Resident step context
description: Stable resident guidance and captured continuation state through the existing SDK prompt contribution registry.
resource: packages/sdk/src/prompt/resident-step.ts
tags: [sdk, agents, context, continuity]
status: draft
---

# Resident step context

`createResidentStepContributions(options)` builds context for one admitted
[resident step](resident-agents.md). It returns two `PromptContribution` objects
for the existing `PromptContributionRegistry`. Register them on the registry
passed to `query` or `drainQuery`; other host contributions can use that same
registry.

`ResidentStepPromptOptions` requires `state: ResidentState` and
`outputInstructions: string`. Optional fields are the admission's approved
`learning: ResidentLearningState`, host-loaded `skillsContext: string`, and
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
summary, admission number, wake reason, approved learning and supplied skills.
Changing that snapshot leaves the static prefix unchanged when the host's
guidance and output contract remain the same.

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
A bounded step can leave useful work for the next admission; completion refers
to the whole authorized objective. The host supplies its own response format
and owns answer validation and durable settlement.

[Approved learning](resident-learning.md) uses `projectResidentLearning` with a
12,000-character projection bound and all skills present in that approved
snapshot selected. The projection reports omitted entries and never emits a
partial learning entry. That limit applies to learning, not to the entire prompt
or host-supplied skill context.

The factory performs no I/O, discovers no instructions and grants no permissions.
Continue passing the host's `projectInstructionContext` and authorization
configuration through their existing runtime paths. The `readOnly` option only
describes an enforced boundary; it must match the host's actual permissions.
Its guidance permits completion of read-only work and does not impose the
interactive coding agent's plan reply or pause-for-approval workflow. Existing
coding doctrine exports and ordinary prompt construction are unchanged.
