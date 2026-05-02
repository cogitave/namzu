---
title: Low-Level Runtime
description: Use query() and drainQuery() directly in @namzu/sdk when you need verification gates, sandbox providers, plugin wiring, event streaming, or query-only runtime controls.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk", "@namzu/openai"]
---

# Low-Level Runtime

`ReactiveAgent.run()` is the best default for most users, but it is intentionally not the entire kernel surface. The lower-level runtime entrypoints are `query()` and `drainQuery()`. Use them when you need features that live below the high-level agent wrappers.

## 1. When to Drop Below `ReactiveAgent`

Use the low-level runtime when you need:

- `verificationGate` policy before tool execution
- a `sandboxProvider` that injects a real sandbox into tool context
- direct `RunEvent` streaming
- plugin manager, task router, agent bus, or compaction wiring
- custom resume-handler behavior for HITL review or checkpoints

If you only need messages, tools, provider, IDs, and a final result, stay with `ReactiveAgent.run()`.

## 2. `ReactiveAgent.run()` vs `drainQuery()`

| Surface | Best for | Notable limits |
| --- | --- | --- |
| `ReactiveAgent.run()` | Standard app integrations and quickstarts | Does not expose query-only runtime fields such as `sandboxProvider` (note: `verificationGate` IS exposed on `ReactiveAgentConfig` and forwarded into `drainQuery`) |
| `drainQuery()` | Low-level runtime control with a final `AgentRun` result | You supply more runtime wiring yourself |
| `query()` | Full async-generator control over every emitted event | You manage iteration over the generator directly |

## 3. Minimal `drainQuery()` Example

```ts
import {
  ProviderRegistry,
  ToolRegistry,
  ReadFileTool,
  LocalSandboxProvider,
  drainQuery,
  autoApproveHandler,
  generateProjectId,
  generateSessionId,
  generateTenantId,
  getRootLogger,
} from '@namzu/sdk'
import { registerOpenAI } from '@namzu/openai'

registerOpenAI()

const { provider } = ProviderRegistry.create({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini',
})

const tools = new ToolRegistry()
tools.register(ReadFileTool)

const sandboxProvider = new LocalSandboxProvider(getRootLogger())

const run = await drainQuery(
  {
    provider,
    tools,
    agentId: 'docs-kernel-agent',
    agentName: 'Docs Kernel Agent',
    messages: [
      {
        role: 'user',
        content: 'Read package.json and tell me the package name.',
      },
    ],
    workingDirectory: process.cwd(),
    runConfig: {
      model: 'gpt-4o-mini',
      tokenBudget: 8_192,
      timeoutMs: 60_000,
      permissionMode: 'plan',
    },
    projectId: generateProjectId(),
    sessionId: generateSessionId(),
    tenantId: generateTenantId(),
    resumeHandler: autoApproveHandler,
    verificationGate: {
      enabled: true,
      allowReadOnlyTools: true,
      denyDangerousPatterns: true,
      rules: [{ type: 'allow_by_category', categories: ['filesystem'] }],
    },
    sandboxProvider,
  },
  async (event) => {
    console.log(event.type)
  },
)

console.log(run.result)
```

This example shows the main low-level boundary:

- `runConfig` still carries model, budget, and permission settings
- query-only fields such as `sandboxProvider`, `pluginManager`, and `agentBus` live beside that config; `verificationGate` is also accepted here but is *also* exposed on `ReactiveAgentConfig` and `SupervisorAgentConfig`, so dropping to `drainQuery` is not required just to enable a policy gate
- `drainQuery()` still returns the same final `AgentRun` shape that high-level agent flows assemble

## 4. What `drainQuery()` Gives You

`drainQuery()` is the convenience wrapper around `query()`:

- it consumes the async generator for you
- it forwards every `RunEvent` to an optional listener
- it returns the final `AgentRun`
- it falls back to `autoApproveHandler` if you omit `resumeHandler`

That makes it the best low-level entrypoint when you still want one final result object.

## 5. Use `query()` for Generator-Level Control

If you need full control over the event stream, use `query()` directly:

```ts
import {
  query,
  mapRunToStreamEvent,
  autoApproveHandler,
  generateProjectId,
  generateSessionId,
  generateTenantId,
} from '@namzu/sdk'

const iterator = query({
  provider,
  tools,
  agentId: 'docs-kernel-agent',
  agentName: 'Docs Kernel Agent',
  messages: [{ role: 'user', content: 'Say hello.' }],
  workingDirectory: process.cwd(),
  runConfig: {
    model: 'gpt-4o-mini',
    tokenBudget: 8_192,
    timeoutMs: 60_000,
  },
  projectId: generateProjectId(),
  sessionId: generateSessionId(),
  tenantId: generateTenantId(),
  resumeHandler: autoApproveHandler,
})

while (true) {
  const next = await iterator.next()

  if (next.done) {
    console.log(next.value.result)
    break
  }

  const event = next.value
  const mapped = mapRunToStreamEvent(event, event.runId)
  if (mapped) {
    console.log(mapped.wire, mapped.data)
  }
}
```

Use this pattern when a transport layer or UI needs every incremental event as it happens.

## 6. Query-Only Fields You Do Not Get Through `ReactiveAgent.run()`

`QueryParams` exposes extra runtime controls that are not currently surfaced on `ReactiveAgentConfig`:

| Field | Purpose |
| --- | --- |
| `verificationGate` | Rule-based allow, deny, or review decisions before tool execution |
| `sandboxProvider` | Create a sandbox for the run and inject it into tool context |
| `pluginManager` | Run plugin hooks and plugin-contributed runtime behavior |
| `taskRouter` | Task-specific model routing |
| `agentBus` | Concurrency coordination and lock-style runtime controls |
| `compactionConfig` | Working-state compaction and message compression policy |
| `contextCache` | Prompt cache and context reuse controls |

That is the main reason this page exists: these are real public runtime features, but they are lower-level than the first-run agent API.

## 7. Resume Handlers and HITL

Low-level runtime control is also where human-in-the-loop policy becomes explicit.

```ts
const resumeHandler = async (request) => {
  switch (request.type) {
    case 'plan_approval':
      return { action: 'approve_plan' }
    case 'tool_review':
      return { action: 'approve_tools' }
    case 'iteration_checkpoint':
      return { action: 'continue' }
  }
}
```

Use `autoApproveHandler` only when the runtime should continue automatically.

## 8. Verification and Sandbox Boundaries

Two low-level runtime fields are easy to confuse:

| Field | Role |
| --- | --- |
| `verificationGate` | Decide whether a tool call should proceed |
| `sandboxProvider` | Constrain what sandbox-aware tools can do if the call proceeds |

This separation matters operationally:

- verification is policy
- sandboxing is containment

Both are lower-level runtime concerns, which is why they are wired through `query()` and `drainQuery()` instead of `defineTool()` alone.

## 9. Event Streaming and SSE Mapping

`query()` and `drainQuery()` emit normalized `RunEvent` values. If you need a wire-friendly event shape, use `mapRunToStreamEvent(event, runId)`.

Important nuance:

- many incremental runtime events map cleanly to wire events
- final completion still comes from the async generator return value or the `drainQuery()` result

That means stream transport code usually needs both:

1. mapped incremental events during execution
2. the final `AgentRun` when execution completes

## 10. Common Mistakes

| Mistake | Why it breaks |
| --- | --- |
| assuming `ReactiveAgent.run()` exposes every runtime field | query-only controls such as `sandboxProvider`, `pluginManager`, and `agentBus` are lower-level (note: `verificationGate` IS on `ReactiveAgentConfig`) |
| forgetting `resumeHandler` when calling `query()` | `query()` requires it directly, unlike `drainQuery()` |
| skipping `workingDirectory` | filesystem tools and path layout lose their stable base path |
| treating `mapRunToStreamEvent()` as the final result channel | completion still comes from generator completion or `drainQuery()` |

## Related

- [SDK Quickstart](../quickstart.md)
- [Run Configuration](./configuration.md)
- [Tool Safety](../tools/safety.md)
- [Connectors and MCP](../integrations/connectors-and-mcp.md)
- [Plugins and MCP Servers](../integrations/plugins.md)
- [Event Bridges](../integrations/event-bridges.md)
- [Query Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/runtime/query/index.ts)
- [Run Event Types](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/types/run/events.ts)
