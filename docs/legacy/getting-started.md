---
title: Getting Started
description: Install the published Namzu packages, choose a provider, and make the first successful request.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk", "@namzu/openai", "@namzu/anthropic", "@namzu/bedrock", "@namzu/openrouter", "@namzu/http", "@namzu/ollama", "@namzu/lmstudio", "@namzu/computer-use"]
---

# Getting Started

Namzu is organized as a core SDK plus published provider and capability packages. The shortest successful path is:

1. install `@namzu/sdk`
2. add exactly one provider package
3. validate the provider with a direct `chat()` call
4. move into a `ReactiveAgent`
5. add optional capability packages such as `@namzu/computer-use` only when your runtime actually needs them

## 1. Choose Your Package Set

| Need | Package set |
| --- | --- |
| Core runtime, tools, registries, IDs, runtime loop | `@namzu/sdk` |
| Direct OpenAI integration | `@namzu/openai` |
| Direct Anthropic integration | `@namzu/anthropic` |
| AWS-native Bedrock usage | `@namzu/bedrock` |
| One account with many upstream vendors | `@namzu/openrouter` |
| Generic OpenAI- or Anthropic-compatible endpoint | `@namzu/http` |
| Local Ollama daemon | `@namzu/ollama` |
| Local LM Studio server | `@namzu/lmstudio` |
| Desktop screenshots and keyboard or mouse input | `@namzu/computer-use` |

## 2. Install the Minimum Set

OpenAI is a good first-run example:

```bash
pnpm add @namzu/sdk @namzu/openai zod
```

Add computer-use only if you need desktop interaction:

```bash
pnpm add @namzu/computer-use
```

## 3. Validate the Provider First

Before introducing agents, confirm the provider wiring works:

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOpenAI } from '@namzu/openai'

registerOpenAI()

const { provider, capabilities } = ProviderRegistry.create({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini',
})

console.log(capabilities)

const response = await provider.chat({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
})

console.log(response.message.content)
```

This step proves:

- the provider package is installed
- the package was registered correctly
- credentials are valid
- the chosen model can answer a basic request

## 4. Move Into an Agent Run

Once provider validation succeeds, move into the normal SDK runtime:

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
    description: 'Return the provided text for runtime validation.',
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
  id: 'getting-started-agent',
  name: 'Getting Started Agent',
  version: '1.0.0',
  category: 'docs',
  description: 'Minimal runtime example for public docs.',
})

const result = await agent.run(
  {
    messages: [
      {
        role: 'user',
        content: 'Say hello, then call echo_text with the text runtime ok.',
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
```

## 5. The Fields People Most Often Miss

The most common first-run omissions are:

- forgetting to call `registerOpenAI()` or the matching provider helper
- omitting `projectId`, `sessionId`, or `tenantId`
- omitting `workingDirectory`
- creating a provider without a default model and then forgetting `params.model`

If your goal is to get one agent running fast, those are the first things to verify.

## 6. Choose the Right Provider Path

Use these defaults unless deployment reality gives you a stronger constraint:

- use [`@namzu/openai`](./providers/openai.md) for direct OpenAI usage
- use [`@namzu/anthropic`](./providers/anthropic.md) for direct Anthropic Messages API usage
- use [`@namzu/openrouter`](./providers/openrouter.md) when vendor flexibility matters
- use [`@namzu/http`](./providers/http.md) for generic compatible endpoints
- use [`@namzu/ollama`](./providers/ollama.md) or [`@namzu/lmstudio`](./providers/lmstudio.md) for local models
- use [`@namzu/bedrock`](./providers/bedrock.md) when auth and governance already live in AWS

## 7. Recommended Reading After the First Run

| If you need... | Read |
| --- | --- |
| The end-to-end first runtime example explained in more detail | [SDK Quickstart](./sdk/quickstart.md) |
| Provider registration and direct provider-call surfaces | [SDK Provider Integration](./sdk/provider-integration/README.md) |
| Choosing between `ReactiveAgent`, `PipelineAgent`, `RouterAgent`, and `SupervisorAgent` | [SDK Agents](./sdk/agents/README.md) |
| Persona layering and skill-file loading | [SDK Prompting](./sdk/prompting/README.md) |
| Knowledge-base-backed retrieval | [SDK Retrieval](./sdk/retrieval/README.md) |
| Persistent session, workspace, and delegation state | [SDK Sessions](./sdk/sessions/README.md) |
| Required runtime IDs and when to reuse them | [Runtime Identities](./sdk/runtime/identities.md) |
| Runtime fields and limit config | [Runtime Configuration](./sdk/runtime/configuration.md) |
| MCP or connector-based integration surfaces | [SDK Integrations](./sdk/integrations/README.md) |
| Tool definition and registry behavior | [SDK Tools](./sdk/tools/README.md) |
| Provider choice guidance | [Provider Selection Guide](./providers/selection-guide.md) |

## Related

- [Documentation Home](./README.md)
- [SDK Quickstart](./sdk/quickstart.md)
- [SDK Runtime](./sdk/runtime/README.md)
- [SDK Provider Integration](./sdk/provider-integration/README.md)
- [SDK Agents](./sdk/agents/README.md)
- [SDK Prompting](./sdk/prompting/README.md)
- [SDK Retrieval](./sdk/retrieval/README.md)
- [SDK Sessions](./sdk/sessions/README.md)
- [Runtime Identities](./sdk/runtime/identities.md)
- [Low-Level Runtime](./sdk/runtime/low-level.md)
- [Providers Overview](./providers/README.md)
- [Computer Use](./computer-use/README.md)
- [ProviderRegistry Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/provider/registry.ts)
