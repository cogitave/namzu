---
title: HTTP Provider
description: Use @namzu/http as the generic zero-dependency provider for OpenAI- or Anthropic-compatible HTTP endpoints.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk", "@namzu/http"]
---

# HTTP Provider

`@namzu/http` is the generic provider package in the Namzu lineup. It is designed for endpoints that already speak an OpenAI-compatible or Anthropic-compatible wire format but do not need a dedicated vendor package in your dependency graph.

## 1. When to Use It

Choose this package when the backend is compatible but not best represented by a first-party Namzu package, or when you want the smallest possible provider dependency surface.

## 2. When Not to Use It

Choose another provider when:

- you want vendor-native SDK behavior and better vendor-specific ergonomics
- you need AWS-native Bedrock auth or region support
- you already know you want the dedicated Ollama or LM Studio integrations

## 3. Install

```bash
pnpm add @namzu/sdk @namzu/http
```

## 4. Register and Create the Provider

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerHttp } from '@namzu/http'

registerHttp()

const { provider } = ProviderRegistry.create({
  type: 'http',
  baseURL: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY!,
  dialect: 'openai',
})
```

## 5. Typical Endpoint Patterns

Use the same provider shape for several classes of endpoint:

### 5.1 OpenAI-compatible cloud endpoint

```ts
const { provider } = ProviderRegistry.create({
  type: 'http',
  baseURL: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY!,
  dialect: 'openai',
  model: 'gpt-4o-mini',
})
```

### 5.2 Anthropic native Messages API

```ts
const { provider } = ProviderRegistry.create({
  type: 'http',
  baseURL: 'https://api.anthropic.com/v1',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  dialect: 'anthropic',
})
```

### 5.3 Local or self-hosted compatible endpoint

```ts
const { provider } = ProviderRegistry.create({
  type: 'http',
  baseURL: 'http://localhost:11434/v1',
  dialect: 'openai',
  model: 'llama3.2',
})
```

## 6. Configuration

| Field | Required | Description |
| --- | --- | --- |
| `baseURL` | Yes | Endpoint base URL |
| `apiKey` | No | API key sent as `Authorization` or `x-api-key` depending on dialect |
| `dialect` | No | `openai` or `anthropic`; defaults to `openai` |
| `headers` | No | Extra HTTP headers |
| `model` | No | Default model when omitted from chat params |
| `timeout` | No | Request timeout in milliseconds |

## 7. Capability Snapshot

The package exports `HTTP_CAPABILITIES`:

```ts
{
  supportsTools: true,
  supportsStreaming: true,
  supportsFunctionCalling: true,
}
```

The actual endpoint still has to support those features correctly.

## 8. Operational Notes

- The package exports `DialectMismatchError`, which is thrown when the declared dialect does not match the actual response shape.
- Use `dialect: 'anthropic'` only for native Anthropic-style endpoints.
- This package is a good fit for self-hosted gateways, vLLM, TGI, Groq-style OpenAI-compatible APIs, and similar targets.
- The provider also implements `listModels()` and `healthCheck()`.

## 9. Why Dialect Choice Matters

The package does not silently auto-detect wire shape. That is deliberate:

- OpenAI-compatible and Anthropic-compatible responses are not interchangeable
- silent coercion can corrupt tool-call arguments or stream parsing
- fail-fast configuration errors are easier to debug than partial runtime corruption

## 10. Common Errors

| Error | Meaning | Fix |
| --- | --- | --- |
| `Unsupported provider type: http` | registration never happened | call `registerHttp()` first |
| `HttpProvider: baseURL is required` | no endpoint URL was passed | supply `baseURL` |
| `DialectMismatchError` | endpoint response shape does not match declared dialect | fix `dialect` or endpoint target |
| missing model error | no default model and no per-call model for OpenAI-style calls | set `model` in config or per call |

## Related

- [Providers Overview](./README.md)
- [Provider Selection Guide](./selection-guide.md)
- [OpenAI Provider](./openai.md)
- [Anthropic Provider](./anthropic.md)
- [Provider Registry](../sdk/provider-integration/registry.md)
- [HTTP Provider Entry](https://github.com/cogitave/namzu/blob/main/packages/providers/http/src/index.ts)
- [HTTP Config Types](https://github.com/cogitave/namzu/blob/main/packages/providers/http/src/types.ts)
