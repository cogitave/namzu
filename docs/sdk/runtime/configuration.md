---
title: Run Configuration
description: Required and optional runtime config for Namzu agents, including model, limits, thinking and effort, permissions, environment, and working directory.
last_updated: 2026-08-05
status: current
related_packages: ["@namzu/sdk"]
---

# Run Configuration

This page explains the runtime config you pass into agents such as `ReactiveAgent`. The goal is not only to list fields, but to make it clear which fields are required, which are policy, and which affect runtime behavior versus tool execution.

## 1. Two Inputs Go Into a Run

Every run has two distinct inputs:

| Input object | Owns |
| --- | --- |
| `AgentInput` | messages, working directory, abort signal, task store, runtime tool overrides |
| `ReactiveAgentConfig` | provider, tools, model, budgets, IDs, persona, skills, advisory config, optional `verificationGate` |

This distinction matters because the SDK separates per-invocation message state from runtime policy and dependencies.

It also matters because some low-level runtime fields are intentionally not exposed on `ReactiveAgentConfig` today. If you need `sandboxProvider`, `pluginManager`, `taskRouter`, `agentBus`, or `compactionConfig`, use [Low-Level Runtime](./low-level.md). `verificationGate` is exposed on `ReactiveAgentConfig` directly (mirrors `SupervisorAgentConfig`); pass it there for a sane policy gate without dropping to `drainQuery`.

## 2. Minimal `ReactiveAgent.run()` Shape

```ts
// Assume `provider`, `tools`, `projectId`, `sessionId`, and `tenantId`
// have already been prepared by your app-level runtime bootstrap.
const result = await agent.run(
  {
    messages: [{ role: 'user', content: 'Hello' }],
    workingDirectory: process.cwd(),
  },
  {
    provider,
    tools,
    model: 'gpt-4o-mini',
    tokenBudget: 8_192,
    timeoutMs: 60_000,
    projectId,
    sessionId,
    tenantId,
  },
)
```

At minimum, a practical run needs:

- `provider`
- `tools`
- `model`
- `tokenBudget`
- `timeoutMs`
- `projectId`
- `sessionId`
- `tenantId`
- `messages`
- `workingDirectory`

## 3. Core Runtime Fields

| Field | Required in practice | What it controls |
| --- | --- | --- |
| `provider` | Yes | LLM backend implementation |
| `tools` | Yes | Tool registry the runtime can expose and execute |
| `model` | Yes | Model identifier used for provider calls |
| `tokenBudget` | Yes | Maximum token budget for the run |
| `timeoutMs` | Yes | Wall-clock timeout for the run |
| `projectId` | Yes | Long-lived project scope |
| `sessionId` | Yes | Immediate session scope |
| `tenantId` | Yes | Isolation boundary |
| `workingDirectory` | Yes | Filesystem root for built-in tool behavior |
| `messages` | Yes | Conversation input for the run |

## 4. Limit and Budget Fields

| Field | Purpose |
| --- | --- |
| `maxIterations` | Hard stop on iteration count |
| `maxResponseTokens` | Output-size guard for model responses |
| `costLimitUsd` | Cost budget guard. Priced from the built-in catalogue; refused rather than ignored when the model has no rate |
| `temperature` | Model creativity or variance control |

These settings shape the runtime loop, not only the provider call.

## 5. Permission and Environment Fields

| Field | Purpose |
| --- | --- |
| `permissionMode` | Tool-permission mode: `auto` or `plan` |
| `env` | Environment variables exposed to tools and sandboxed commands |

`permissionMode` is especially important:

- `auto` is the normal runtime mode
- `plan` blocks non-read-only tools at execution time in the tool registry

### What a sandbox is rooted at

`runConfig.sandbox.workspace` decides which directory a sandboxed tool call
acts on, and the two answers protect different things.

| | `'ephemeral'` (default) | `'working-directory'` |
| --- | --- | --- |
| Root | a fresh temp directory | the run's own `workingDirectory` |
| Your files | invisible to the agent | the subtree the agent operates on |
| A destructive command | destroys a temp directory | destroys your files |
| Good for | untrusted work, evaluation, anything you would not hand a shell | an agent asked to change the project it is looking at |

Confinement is the same in both: the agent is bounded to one subtree either
way. What changes is whose subtree. `'ephemeral'` is the default and stays
the default — every sandboxed run before this option existed got a temp
directory, and changing that silently would point them all at real files.

`'working-directory'` with no `workingDirectory` on the run is **refused**,
before the sandbox is created. It does not fall back to ephemeral. The
kernel could reach for `process.cwd()` there and will not: that confines
whatever directory the host process happens to be in, which is not the tree
you named, and a caller told "your files are protected" by something not
looking at them is worse off than one who got an error.

`env` is useful when tools need controlled environment data such as:

- API base URLs
- feature flags
- CLI-specific runtime variables

## 6. Prompt and Behavior Fields

`ReactiveAgentConfig` also supports higher-level prompt and reasoning inputs:

| Field | Purpose |
| --- | --- |
| `systemPrompt` | Direct system-level instructions |
| `basePrompt` | Base prompt segment |
| `persona` | Structured prompt identity |
| `skills` | Structured skill bundle list |
| `advisory` | Advisor configuration |
| `thinking` | Whether the model reasons before answering, and with how large a budget |
| `effort` | How much work the model spends on each call |

These fields change how the runtime assembles prompt context before it calls the provider.

### `thinking` and `effort`

Both are declared on `BaseAgentConfig`, which every agent config extends, so they
are set the same way whichever entry point you use:

```ts
// Assume `provider`, `tools`, `model`, `projectId`, `sessionId` and `tenantId`
// were prepared by your runtime bootstrap, as in section 2.
const agent = new ReactiveAgent()

await agent.run(
  {
    messages: [{ role: 'user', content: 'Reconcile these two ledgers.' }],
    workingDirectory: process.cwd(),
  },
  {
    provider,
    tools,
    model,
    tokenBudget: 32_768,
    timeoutMs: 120_000,
    projectId,
    sessionId,
    tenantId,
    thinking: { type: 'adaptive' },
    effort: 'high',
  },
)
```

They are **siblings**, not one nested in the other. On some models the two are
independent controls that apply together — effort shapes the answer while a
token budget sets how deep the reasoning goes — and nesting `effort` inside
`thinking` would make that combination unsayable.

Which of the two does the work depends on the thinking mode:

| `thinking.type` | Depth is set by | `effort` |
| --- | --- | --- |
| `adaptive` | the model, per request | the primary depth lever — low effort may skip thinking entirely on easy input |
| `enabled` | `budgetTokens` | shapes the answer; does not move thinking depth |
| `disabled` | — | still applies on models that accept it |

The modes are not interchangeable and a driver must not guess between them:
newer models refuse `enabled`, older ones refuse `adaptive`, and some refuse
`disabled` because they cannot stop reasoning at all. What you set here is a
declared intent, resolved by each driver against the model it is about to call.

Both fields are **run-level rather than per-step.** Effort in particular is a
property of what the run is *for*, and a value that moves between steps buys a
different answer shape at the cost of the prompt-cache prefix on every step that
changes it: the provider does not preserve a cached prefix across a change of
effort.

**A driver that cannot honour either one refuses the run rather than dropping
the field.** That is the rule for both, and effort is the reason it matters
most: a dropped `thinking` leaves an empty reasoning list that someone might
notice, while a dropped `effort` leaves a perfectly ordinary answer — so a run
requested at `max` is indistinguishable from one at the default, including in
what it cost. Turning a capability *off* is not a refusal, so a
`thinking: { type: 'disabled' }` config shared across models does not fail on
the ones that were never going to reason anyway.

Which levels a model accepts is the driver's to know; see
[Anthropic Provider](../../providers/anthropic.md) for how one driver resolves
them per model.

## 7. Hierarchy and Advanced Fields

| Field | Purpose |
| --- | --- |
| `parentRunId` | Links a child run back to its parent |
| `depth` | Tracks hierarchy depth in parent/child agent trees |
| `contextLevel` | Signals how much context should be carried |
| `invocationState` | Shared invocation state passed through hierarchies |

These are more relevant for supervisors, orchestration layers, or manager-driven spawning than for the first quickstart.

## 8. AgentInput Fields

`AgentInput` includes these runtime-time fields:

| Field | Purpose |
| --- | --- |
| `messages` | Input conversation |
| `workingDirectory` | Base directory for filesystem-oriented tools |
| `signal` | Abort signal for cancellation |
| `taskStore` | Optional task persistence surface |
| `runtimeToolOverrides` | Per-run tool availability overrides |

`workingDirectory` affects several built-in tools directly:

- `read`
- `write`
- `edit`
- `glob`
- `grep`
- `bash`

## 9. Runtime Defaults at the SDK Level

The SDK also exports `RuntimeConfigSchema` and `RUNTIME_DEFAULTS` for higher-level application config assembly.

Important defaults include:

| Field | Default |
| --- | --- |
| `model` | `qwen/qwen3.6-plus:free` |
| `temperature` | `0.3` |
| `tokenBudget` | `100_000` |
| `maxResponseTokens` | `8192` |
| `timeoutMs` | `600_000` |
| `maxIterations` | `200` |

Those defaults are useful for application-level config objects, but most production apps should still set explicit values for the runs they actually care about.

## 10. Recommended App Pattern

Use one app-level runtime config object and derive agent configs from it:

```ts
import {
  RUNTIME_DEFAULTS,
  generateProjectId,
  generateSessionId,
  generateTenantId,
} from '@namzu/sdk'

const runtime = {
  ...RUNTIME_DEFAULTS,
  model: 'gpt-4o-mini',
  tokenBudget: 16_384,
  timeoutMs: 120_000,
}

// Assume `provider` and `tools` were created during runtime bootstrap.
const agentConfig = {
  provider,
  tools,
  model: runtime.model,
  tokenBudget: runtime.tokenBudget,
  timeoutMs: runtime.timeoutMs,
  maxIterations: runtime.maxIterations,
  temperature: runtime.temperature,
  projectId: generateProjectId(),
  sessionId: generateSessionId(),
  tenantId: generateTenantId(),
}
```

## 11. Common Mistakes

| Mistake | Consequence |
| --- | --- |
| omitting `workingDirectory` | filesystem tools have no stable base path |
| passing `permissionMode: 'plan'` unexpectedly | mutating tools are blocked |
| keeping `tokenBudget` too low for tool-rich tasks | early stop or forced finalization |
| forgetting `maxResponseTokens` in provider-direct calls | large responses can be harder to control |
| mixing app config defaults and per-run overrides inconsistently | debugging run behavior becomes harder |

## Related

- [SDK Quickstart](../quickstart.md)
- [Run Identities](./identities.md)
- [Low-Level Runtime](./low-level.md)
- [Tool Safety](../tools/safety.md)
- [SDK Runtime](./README.md)
- [RuntimeConfigSchema Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/config/runtime.ts)
