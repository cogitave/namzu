---
title: SDK Quickstart
description: Run a minimal Namzu reactive agent with one custom tool and a real provider.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk", "@namzu/openai"]
---

# SDK Quickstart

This page is the smallest complete runtime setup that still reflects how the public SDK actually works today. It starts from provider registration, adds one typed tool, and runs a `ReactiveAgent` with the required ID fields.

## 1. Install

```bash
pnpm add @namzu/sdk @namzu/openai zod
```

## 2. Prerequisite Environment

For the example below, set:

```bash
export OPENAI_API_KEY=your_key_here
```

## 3. Minimal End-to-End Example

```ts
import {
  ProviderRegistry,
  ReactiveAgent,
  ToolRegistry,
  defineTool,
  generateProjectId,
  generateSessionId,
  generateTenantId,
} from '@namzu/sdk'
import { registerOpenAI } from '@namzu/openai'
import { z } from 'zod'

registerOpenAI()

const { provider } = ProviderRegistry.create({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini',
})

const tools = new ToolRegistry()

tools.register(
  defineTool({
    name: 'echo_text',
    description: 'Return the provided text for wiring and prompt checks.',
    inputSchema: z.object({ text: z.string() }),
    category: 'analysis',
    permissions: [],
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
    async execute({ text }) {
      return { success: true, output: text }
    },
  }),
)

const agent = new ReactiveAgent({
  id: 'quickstart-agent',
  name: 'Quickstart Agent',
  version: '1.0.0',
  category: 'example',
  description: 'Minimal reactive agent used in docs.',
})

const result = await agent.run(
  {
    messages: [
      {
        role: 'user',
        content: 'Say hello, then call echo_text with the phrase tool ok.',
      },
    ],
    workingDirectory: process.cwd(),
  },
  {
    provider,
    tools,
    model: 'gpt-4o-mini',
    tokenBudget: 8_192,
    timeoutMs: 60_000,
    projectId: generateProjectId(),
    sessionId: generateSessionId(),
    tenantId: generateTenantId(),
  },
)

console.log(result.result)
console.log(result.toolCallCount)
```

## 4. Why These Pieces Matter

Each part in the example maps to a stable SDK boundary:

| Piece | Why it is required |
| --- | --- |
| `registerOpenAI()` | Adds the provider package to `ProviderRegistry` |
| `ProviderRegistry.create()` | Returns the `LLMProvider` instance the agent will use |
| `ToolRegistry` | Holds callable tools and converts them into model-facing schemas |
| `ReactiveAgent` | Runs the agent loop over messages, tools, and provider calls |
| `projectId`, `sessionId`, `tenantId` | Required runtime identity fields for current session-hierarchy rules |

## 5. What the Tool Is Doing

The custom `echo_text` tool is intentionally simple because it proves four things at once:

- the tool schema is valid
- the tool registry is working
- the model can see and choose the tool
- tool results return into the runtime loop correctly

For a first integration, that is more useful than jumping straight to filesystem or shell tools.

## 6. What the Result Gives You

`ReactiveAgent.run()` returns a structured result object with fields such as:

- `runId`
- `status`
- `stopReason`
- `usage`
- `cost`
- `iterations`
- `messages`
- `result`
- `toolCallCount`

That means you can use the same result both for user-facing output and for runtime instrumentation or debugging.

## 7. Common First Errors

| Error shape | Usual cause |
| --- | --- |
| `Unsupported provider type` | The provider package was not registered before `ProviderRegistry.create()` |
| `DuplicateProviderError` | The same provider was registered twice without `{ replace: true }` |
| `requires sessionId, projectId, and tenantId` | One of the runtime IDs was omitted from agent config |
| Tool returns `success: false` | The tool threw; `defineTool()` converts the throw into a structured tool failure |

## 8. Recommended Next Step After This Example

Once this exact quickstart works:

1. replace `echo_text` with real tool surfaces
2. decide which built-in tools should be active by default
3. choose whether you need verification or plan mode
4. keep `projectId`, `sessionId`, and `tenantId` stable according to your app's identity model

## 9. Where to Go Next

- Read [SDK Tools](./tools/README.md) if you are adding real tool surfaces.
- Read [Built-In Tools](./tools/built-in.md) if you want to start from the shipped tool set.
- Read [Provider Operations](./provider-integration/operations.md) if you want a direct provider preflight before adding more runtime structure.
- Read [Agents and Orchestration](./agents/README.md) if the runtime is outgrowing a single `ReactiveAgent`.
- Read [Skills and Personas](./prompting/README.md) if you want repeatable behavior without hardcoding one giant `systemPrompt`.
- Read [Retrieval and RAG](./retrieval/README.md) if you need knowledge-base-backed answers.
- Read [Sessions, Workspaces, and Retention](./sessions/README.md) if you need durable session or delegation state.
- Read [Run Identities](./runtime/identities.md) if you need a durable ID strategy.
- Read [Run Configuration](./runtime/configuration.md) if you need to tune limits and policy.
- Read [Low-Level Runtime](./runtime/low-level.md) if you need verification, sandboxing, or raw event streaming.
- Read [Connectors and MCP](./integrations/connectors-and-mcp.md) if your runtime needs external-system integrations or MCP interoperability.
- Read [Providers Overview](../providers/README.md) if you need a different model backend.
- Read [Computer Use](../computer-use/README.md) if the agent needs screenshots or desktop input.

## Related

- [SDK Overview](./README.md)
- [SDK Tools](./tools/README.md)
- [Provider Registry](./provider-integration/registry.md)
- [Provider Operations](./provider-integration/operations.md)
- [Agents and Orchestration](./agents/README.md)
- [Skills and Personas](./prompting/README.md)
- [Retrieval and RAG](./retrieval/README.md)
- [Sessions, Workspaces, and Retention](./sessions/README.md)
- [Run Identities](./runtime/identities.md)
- [Run Configuration](./runtime/configuration.md)
- [Low-Level Runtime](./runtime/low-level.md)
- [Connectors and MCP](./integrations/connectors-and-mcp.md)
- [OpenAI Provider](../providers/openai.md)
- [ReactiveAgent Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/agents/ReactiveAgent.ts)
- [ID Utilities Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/utils/id.ts)
