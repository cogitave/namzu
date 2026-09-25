---
type: Reference
title: Host capabilities
description: Compose reusable host behavior for runAgent without changing plugin installation or tool source ownership.
resource: packages/sdk/src/capabilities/index.ts
tags: [sdk, agents, capabilities, toolsets]
status: stable
---

# Host capabilities

`defineCapability` groups a host's instructions, toolsets, prompt contributions, input and output guardrails, and model settings under one stable `id`. Pass these declarations to `runAgent({ capabilities })`. The host constructs them in TypeScript; they are separate from file plugins, which have installation, enablement and trust rules. A capability keeps each toolset's original `ToolSource`, so its tools follow the same tool admission and result screening path as other tools. If calls require human approval, the host must configure `runAgent.authorizationGate`.

The three units answer different questions: a `Toolset` says where tools come from; a host `Capability` says which reusable behaviors one agent invocation needs; a file `Plugin` says which installed code an operator has admitted and enabled. `AgentCapabilities` is older metadata about whether an agent supports tools, streaming, concurrency and children; it is not a behavior bundle. This separation keeps plugin discovery and model-chosen tool availability from silently granting authority. Host capabilities are resolved before the first model call; they are not loaded by a model mid-turn.

```ts
import { MockLLMProvider, defineCapability, runAgent, toolset } from '@namzu/sdk'

const catalog = defineCapability({
  id: 'catalog',
  instructions: 'Use the catalog when answering item questions.',
  toolsets: [toolset('catalog', [])],
  modelSettings: { temperature: 0 },
})

const result = await runAgent({
  provider: new MockLLMProvider(),
  model: 'mock-model',
  prompt: 'Find an item.',
  capabilities: [catalog],
})
void result.output
```

`instructions` are host-authored system guidance. They enter the prompt as a `dynamic` `PromptContribution`, after the base `runAgent.instructions`. For observations that belong after history, or guidance that changes on each model request, supply a `PromptContribution` with the appropriate placement instead. These contributions are registered in capability order; duplicate contribution IDs fail before the first model call. File plugin instructions continue to be labelled untrusted context.

`modelSettings` can set `temperature`, `thinking` and `effort` for the whole invocation. Later capabilities override earlier ones for the same field. A value passed directly to `runAgent` wins over every capability. Toolsets are appended after `runAgent.toolsets`; a duplicate tool name is refused by the existing `ToolManager`, with both tool sources named.

`inputGuardrails` run before the model call; `outputGuardrails` inspect the final answer. They run in capability order, followed by guardrails supplied directly to `runAgent`. An empty direct list does not remove a capability's guardrails. Output rewriting happens after text deltas may have reached a streaming listener; the host must handle the final correction. The existing tool-result guardrail defaults and `runAgent.toolResultGuardrails` keep their separate contract.

## Per-run factories

`dynamicCapability(id, forRun)` calls `forRun` once on every `runAgent` invocation, before the first model request. It receives the working directory, model, prompt, four identity fields and the caller's cancellation signal. Return a declaration with the same `id`, or `null` to omit it for that invocation. Returning another ID fails before the model runs: stable identity matters when a conversation continues across calls. A factory should create fresh mutable state for each invocation and pass the signal to any I/O it starts. The caller stops waiting when that signal aborts; JavaScript cannot forcibly stop work that ignores it.

```ts
import { defineCapability, dynamicCapability } from '@namzu/sdk'

const projectContext = dynamicCapability('project-context', (ctx) =>
  defineCapability({
    id: 'project-context',
    instructions: `The current project is ${ctx.projectId}.`,
  }),
)
void projectContext
```

Capability IDs must be nonempty and unique in one invocation. A factory can choose whether to contribute, but it cannot install code or grant permission on its own. When the host configures `authorizationGate`, that gate decides what a tool call may do. `runAgent` resolves the bundle anew each time; a long-lived session does not share its factory's returned object by default.
