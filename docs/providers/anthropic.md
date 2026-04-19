---
title: Anthropic Provider
description: Configure @namzu/anthropic for the Anthropic Messages API through Namzu.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk", "@namzu/anthropic"]
---

# Anthropic Provider

`@namzu/anthropic` is the direct Anthropic integration for Namzu. It wraps the official Anthropic SDK and exposes the provider as the `anthropic` type in `ProviderRegistry`.

## 1. When to Use It

Choose this package when you want native Anthropic Messages API behavior instead of going through a compatibility layer.

## 2. When Not to Use It

Choose another provider when:

- you need AWS-native auth and region semantics, in which case [`@namzu/bedrock`](./bedrock.md) is a better fit
- your endpoint is only Anthropic-compatible over raw HTTP, in which case [`@namzu/http`](./http.md) may be the simpler abstraction

## 3. Install

```bash
pnpm add @namzu/sdk @namzu/anthropic
```

## 4. Register and Create the Provider

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerAnthropic } from '@namzu/anthropic'

registerAnthropic()

const { provider, capabilities } = ProviderRegistry.create({
  type: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4-20250514',
  maxTokens: 4096,
})
```

## 5. Sanity-Check With a Direct Provider Call

```ts
const response = await provider.chat({
  model: 'claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
  maxTokens: 1024,
})

console.log(response.message.content)
```

## 6. Use It With a Reactive Agent

```ts
import {
  ReactiveAgent,
  ToolRegistry,
  generateProjectId,
  generateSessionId,
  generateTenantId,
} from '@namzu/sdk'

const agent = new ReactiveAgent({
  id: 'anthropic-agent',
  name: 'Anthropic Agent',
  version: '1.0.0',
  category: 'docs',
  description: 'Provider documentation example.',
})

const result = await agent.run(
  {
    messages: [{ role: 'user', content: 'Say hello.' }],
    workingDirectory: process.cwd(),
  },
  {
    provider,
    tools: new ToolRegistry(),
    model: 'claude-sonnet-4-20250514',
    tokenBudget: 8_192,
    timeoutMs: 60_000,
    projectId: generateProjectId(),
    sessionId: generateSessionId(),
    tenantId: generateTenantId(),
  },
)
```

## 7. Configuration

| Field | Required | Description |
| --- | --- | --- |
| `apiKey` | Yes | Anthropic API key |
| `model` | No | Default model for calls that omit `params.model` |
| `baseURL` | No | Override endpoint URL for a compatible proxy or gateway |
| `timeout` | No | Request timeout in milliseconds |
| `defaultHeaders` | No | Extra headers appended to every request |
| `maxTokens` | No | Default `max_tokens` value; Anthropic requires this field at request time |

## 8. Capability Snapshot

The package exports `ANTHROPIC_CAPABILITIES`:

```ts
{
  supportsTools: true,
  supportsStreaming: true,
  supportsFunctionCalling: true,
}
```

## 9. Operational Notes

- Anthropic requires `max_tokens`, so setting `maxTokens` at provider creation time is a good default.
- `baseURL` can point at proxies or gateways, but for Bedrock-hosted Anthropic models [`@namzu/bedrock`](./bedrock.md) is the better fit.
- The provider also implements `listModels()` and `healthCheck()`.

## 10. Common Errors

| Error | Meaning | Fix |
| --- | --- | --- |
| `Unsupported provider type: anthropic` | registration never happened | call `registerAnthropic()` before `create()` |
| missing API key error | `apiKey` not provided | pass a valid Anthropic API key |
| tool-rich calls fail unexpectedly | `max_tokens` handling was overlooked in direct calls | set `maxTokens` at provider creation or per call |

## Related

- [Providers Overview](./README.md)
- [Provider Selection Guide](./selection-guide.md)
- [Bedrock Provider](./bedrock.md)
- [HTTP Provider](./http.md)
- [Provider Registry](../sdk/provider-integration/registry.md)
- [Anthropic Provider Entry](https://github.com/cogitave/namzu/blob/main/packages/providers/anthropic/src/index.ts)
- [Anthropic Config Types](https://github.com/cogitave/namzu/blob/main/packages/providers/anthropic/src/types.ts)
