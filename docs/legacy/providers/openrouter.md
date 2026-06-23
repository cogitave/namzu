---
title: OpenRouter Provider
description: Configure @namzu/openrouter for multi-vendor model access through OpenRouter.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk", "@namzu/openrouter"]
---

# OpenRouter Provider

`@namzu/openrouter` gives Namzu access to OpenRouter's multi-vendor model catalog through a single provider package. It is useful when vendor flexibility matters more than binding directly to one model API.

## 1. When to Use It

Choose this package when you want to switch among vendors or models without changing the Namzu runtime wiring.

## 2. When Not to Use It

Choose another provider when:

- you already know the runtime is tied to one vendor and want the smallest translation layer
- you only need a generic OpenAI-compatible endpoint and do not need OpenRouter-specific behavior

## 3. Install

```bash
pnpm add @namzu/sdk @namzu/openrouter
```

## 4. Register and Create the Provider

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOpenRouter } from '@namzu/openrouter'

registerOpenRouter()

const { provider, capabilities } = ProviderRegistry.create({
  type: 'openrouter',
  apiKey: process.env.OPENROUTER_API_KEY!,
  siteUrl: 'https://myapp.example',
  siteName: 'My App',
})
```

## 5. Sanity-Check With a Direct Provider Call

```ts
const response = await provider.chat({
  model: 'anthropic/claude-sonnet-4',
  messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
})

console.log(response.message.content)
```

## 6. Configuration

| Field | Required | Description |
| --- | --- | --- |
| `apiKey` | Yes | OpenRouter API key |
| `baseUrl` | No | Override the default OpenRouter API base URL |
| `siteUrl` | No | Optional site URL for OpenRouter analytics |
| `siteName` | No | Optional site name for OpenRouter analytics |
| `timeout` | No | Request timeout in milliseconds |

## 7. Capability Snapshot

The package exports `OPENROUTER_CAPABILITIES`:

```ts
{
  supportsTools: true,
  supportsStreaming: true,
  supportsFunctionCalling: true,
}
```

Actual tool quality still depends on the chosen upstream model.

## 8. Operational Notes

- Model identifiers typically use the `vendor/model-name` form.
- This package is fetch-based and keeps runtime dependencies small.
- If you do not need OpenRouter-specific behavior and only need a generic OpenAI-compatible client, [`@namzu/http`](./http.md) is the lighter conceptual fit.
- `OPENROUTER_BASE_URL` can override the default base URL process-wide.
- `siteUrl` and `siteName` are useful when you want OpenRouter-side attribution or analytics context.
- The provider also implements `listModels()` and `healthCheck()`.

## 9. Common Errors

| Error | Meaning | Fix |
| --- | --- | --- |
| `Unsupported provider type: openrouter` | registration never happened | call `registerOpenRouter()` first |
| missing API key error | no `apiKey` passed | set `OPENROUTER_API_KEY` and pass it into config |
| model not found | incorrect `vendor/model` identifier | verify the model name in OpenRouter's catalog |

## Related

- [Providers Overview](./README.md)
- [Provider Selection Guide](./selection-guide.md)
- [HTTP Provider](./http.md)
- [Provider Registry](../sdk/provider-integration/registry.md)
- [OpenRouter Provider Entry](https://github.com/cogitave/namzu/blob/main/packages/providers/openrouter/src/index.ts)
- [OpenRouter Config Types](https://github.com/cogitave/namzu/blob/main/packages/providers/openrouter/src/types.ts)
