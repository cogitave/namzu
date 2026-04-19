---
title: Provider Operations
description: Direct provider usage in @namzu/sdk, including chat, streaming, tool-call inspection, model listing, health checks, and capability-driven routing.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk", "@namzu/openai", "@namzu/anthropic", "@namzu/bedrock", "@namzu/openrouter", "@namzu/http", "@namzu/ollama", "@namzu/lmstudio"]
---

# Provider Operations

`ProviderRegistry` is not only an agent bootstrap tool. It also gives you a normalized direct-call surface for preflight checks, admin screens, streaming UIs, and lower-level orchestration that does not want to jump straight into `ReactiveAgent`.

## 1. When Direct Provider Calls Are the Right Tool

Use the provider directly when you need:

- a simple preflight request before enabling agent runtime
- streaming output without the full agent loop
- model catalogs for admin or setup UIs
- health probes or background readiness checks
- custom orchestration where you want to inspect tool calls yourself

Use agents when you want Namzu to own the iterative loop, tool execution, and final run assembly.

## 2. Create a Provider and Inspect Capabilities

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOpenAI } from '@namzu/openai'

registerOpenAI()

const { provider, capabilities } = ProviderRegistry.create({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini',
})

console.log(capabilities.supportsStreaming)
console.log(capabilities.supportsTools)
console.log(capabilities.supportsFunctionCalling)
```

The returned `capabilities` object is the fastest way to branch UI or runtime behavior before the first call.

## 3. Use `chat()` for Synchronous Direct Calls

```ts
const response = await provider.chat({
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system', content: 'Answer briefly.' },
    { role: 'user', content: 'Summarize what Namzu providers normalize.' },
  ],
  temperature: 0.2,
})

console.log(response.message.content)
console.log(response.finishReason)
console.log(response.usage.totalTokens)
```

`chat()` is the easiest path when you want one normalized response object and do not need incremental chunks.

## 4. Use `chatStream()` for Incremental Output

```ts
let text = ''

for await (const chunk of provider.chatStream({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Count from one to three.' }],
})) {
  if (chunk.error) {
    throw new Error(chunk.error)
  }

  if (chunk.delta.content) {
    text += chunk.delta.content
    process.stdout.write(chunk.delta.content)
  }

  if (chunk.finishReason) {
    console.log('\nfinish reason:', chunk.finishReason)
  }
}

console.log(text)
```

The stream chunks are normalized across providers:

- `delta.content` carries text
- `delta.toolCalls` carries incremental tool-call deltas
- `finishReason` tells you why generation ended
- `usage` may appear near the end of the stream

## 5. Direct Tool-Call Inspection

Direct provider calls do not execute tools for you. They only return normalized tool-call requests when the model chooses them.

```ts
import { ToolRegistry, defineTool } from '@namzu/sdk'
import { z } from 'zod'

const tools = new ToolRegistry()

tools.register(
  defineTool({
    name: 'echo_text',
    description: 'Return the provided text.',
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

const response = await provider.chat({
  model: 'gpt-4o-mini',
  messages: [
    {
      role: 'user',
      content: 'Call echo_text with the text direct provider flow.',
    },
  ],
  tools: tools.toLLMTools(),
  toolChoice: 'auto',
})

console.log(response.message.toolCalls)
```

Important boundary:

- providers return tool-call intent
- `ToolRegistry.execute()` or the agent runtime performs the actual tool execution

If you need automatic tool execution and iterative reasoning, move back up to `ReactiveAgent` or [Low-Level Runtime](../runtime/low-level.md).

## 6. Optional Provider Methods

Most published providers implement two optional utility methods:

- `listModels()`
- `healthCheck()`

Use them defensively because they are optional on the shared contract:

```ts
const healthy = await provider.healthCheck?.()
const models = await provider.listModels?.()

console.log(healthy ?? 'healthCheck not implemented')
console.log(models ?? 'listModels not implemented')
```

Typical uses:

- `healthCheck()` before accepting traffic
- `listModels()` when rendering setup forms or validating config choices

## 7. Capability-Driven Routing

The capability object returned by `ProviderRegistry.create()` is often enough to decide which runtime shape to use:

| Capability | Typical decision |
| --- | --- |
| `supportsStreaming` | Turn on token-by-token or chunk-by-chunk UI |
| `supportsTools` | Enable tool-enabled agents or direct tool-call inspection |
| `supportsFunctionCalling` | Prefer structured tool orchestration instead of plain-text prompting |

This lets you branch behavior without hardcoding vendor names.

## 8. Direct Provider Calls vs Agent Runtime

| If you need... | Use |
| --- | --- |
| One request and one normalized answer | `provider.chat()` |
| Incremental output | `provider.chatStream()` |
| Health or model discovery | `healthCheck()` / `listModels()` |
| Tool execution loop, safety policy, and final run assembly | `ReactiveAgent.run()` or `drainQuery()` |

## 9. Common Mistakes

| Mistake | Why it hurts |
| --- | --- |
| assuming `chat()` executes tools automatically | direct provider usage only returns tool-call intent |
| assuming every provider implements `listModels()` and `healthCheck()` | those methods are optional on the shared interface |
| ignoring `capabilities` and branching by vendor name instead | you lose the main benefit of the provider abstraction |
| jumping straight into agents before a direct preflight request | setup errors become harder to isolate |

## Related

- [Provider Registry](./registry.md)
- [SDK Quickstart](../quickstart.md)
- [Low-Level Runtime](../runtime/low-level.md)
- [Providers Overview](../../providers/README.md)
- [Provider Interface Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/types/provider/interface.ts)
- [Provider Registry Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/provider/registry.ts)
