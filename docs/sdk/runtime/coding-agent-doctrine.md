---
uid: namzu.sdk.runtime.coding-agent-doctrine
title: The coding-agent doctrine
description: Put the kernel's rules for how a coding agent works into the system prompt as a static contribution, with the delegation rules separable for a sub-agent that has no Agent tool.
type: Guide
diataxis: how-to
owner: cogitave/namzu
status: active
timestamp: 2026-09-02T00:00:00Z
lastReviewed: 2026-09-02
resource: packages/sdk/src/prompt/coding-agent-doctrine.ts
tags: [sdk, runtime, prompt]
---

# The coding-agent doctrine

A system prompt built from the kernel says who the agent is and what tools
it has. It did not say how to work — act or ask, deliver the whole scope,
report a failing test as failing, prefer `edit` over `sed -i`, never push
without being asked — and each model filled that in differently. The
doctrine is that text, owned by the kernel so every host reads the same
rules.

## Register it

```ts
import { codingAgentDoctrineContribution, PromptContributionRegistry } from '@namzu/sdk'

const contributions = new PromptContributionRegistry()
contributions.register(codingAgentDoctrineContribution())
```

Pass `contributions` to `query`. The contribution is `static`: it depends on
nothing that changes inside a run, so it lives in the cached prefix, after
`systemPrompt` and the skills section. A host keeps its own identity block
in `systemPrompt` and the doctrine lands behind it.

## Two texts

| Export | Names | For |
| --- | --- | --- |
| `CODING_AGENT_WORKING_DOCTRINE` | the builtins only — `read`, `edit`, `write`, `bash`, `grep`, `glob` | every agent, including delegated sub-agents |
| `CODING_AGENT_DELEGATION_DOCTRINE` | `task_create`, `task_update`, `Agent`, the `explore` delegate | the parent only |

`codingAgentDoctrineContribution({ delegation: false })` renders the working
text alone. Use it for a sub-agent's prompt: a rule about a tool the reader
does not have is not guidance, it is an instruction to fail.

`PLAN_MODE_DOCTRINE` is a third text for a session whose permission layer
refuses every mutation. It says what that layer enforces anyway, so the
model plans instead of discovering the boundary one refused call at a time.
It is not part of the contribution; a host adds it while the mode is on.

## Related

- [Agents defined in files](../tools/file-defined-agents.md)
