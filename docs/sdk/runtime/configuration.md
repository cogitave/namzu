---
title: Run Configuration
description: Required and optional runtime config for Namzu agents, including model, limits, permissions, environment, and working directory.
last_updated: 2026-04-18
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
| `costLimitUsd` | Cost budget guard when pricing is available |
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

These fields change how the runtime assembles prompt context before it calls the provider.

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

- `Read`
- `Write`
- `Edit`
- `Glob`
- `Grep`
- `Bash`

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
