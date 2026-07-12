---
title: OpenAI Provider
description: Configure @namzu/openai for direct OpenAI usage with the Namzu provider registry.
last_updated: 2026-07-12
status: current
related_packages: ["@namzu/sdk", "@namzu/openai"]
---

# OpenAI Provider

`@namzu/openai` is the direct OpenAI integration for Namzu. It wraps the official `openai` npm package and registers an `openai` provider type inside `ProviderRegistry`.

## 1. When to Use It

Choose this package when OpenAI is the primary backend and you want the smallest amount of translation between Namzu and the vendor SDK.

## 2. When Not to Use It

Choose another provider when:

- you need Anthropic-native behavior and should use [`@namzu/anthropic`](./anthropic.md)
- your deployment is Bedrock-native and should use [`@namzu/bedrock`](./bedrock.md)
- your endpoint is broadly OpenAI-compatible but not meaningfully OpenAI-specific, where [`@namzu/http`](./http.md) is usually the clearer fit

## 3. Install

```bash
pnpm add @namzu/sdk @namzu/openai
```

## 4. Register and Create the Provider

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOpenAI } from '@namzu/openai'

registerOpenAI()

const { provider, capabilities } = ProviderRegistry.create({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini',
})
```

## 5. Sanity-Check With a Direct Provider Call

```ts
const response = await provider.chat({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
})

console.log(response.message.content)
```

This is the best first check because it confirms:

- registration worked
- credentials are valid
- the chosen model is reachable

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
  id: 'openai-agent',
  name: 'OpenAI Agent',
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

## 7. Configuration

| Field | Required | Description |
| --- | --- | --- |
| `apiKey` | Yes | OpenAI API key |
| `model` | No | Default model for calls that omit `params.model` |
| `baseURL` | No | Override endpoint URL for compatible or enterprise deployments |
| `organization` | No | OpenAI organization identifier |
| `project` | No | OpenAI project identifier |
| `timeout` | No | Request timeout in milliseconds |
| `defaultHeaders` | No | Extra headers appended to every request |

## 8. Capability Snapshot

The package exports `OPENAI_CAPABILITIES`:

```ts
{
  supportsTools: true,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsAbortSignal: true,
}
```

That makes this provider a strong default for general-purpose tool-using agents.

## 9. Error Handling and Cancellation

`chat()` and `chatStream()` failures are normalized to the SDK's `ProviderRequestError` with a runtime-classifiable `kind` — `throttle`, `context_overflow`, `auth`, `bad_request`, `server`, `network`, `aborted`, or `unknown`. `Retry-After` and `x-ratelimit-*` reset headers are read into `retryAfterMs`, which the runtime's retry loop honors in place of its computed backoff.

The vendor SDK's internal retry loop is **disabled** (`maxRetries: 0`), so the SDK's `retry.maxAttempts` bounds the number of requests that physically reach the network. A direct `provider.chat()` call outside the agent loop therefore performs exactly one request.

`supportsAbortSignal` is `true`: `params.signal` is forwarded to the transport, so a cancel aborts an in-flight request rather than waiting for the next iteration boundary.

See [Reliability and Cancellation](../sdk/runtime/reliability.md).

## 10. Operational Notes

- `baseURL` can point at OpenAI-compatible or enterprise endpoints.
- If your target is generic rather than truly OpenAI-specific, [`@namzu/http`](./http.md) is often the better conceptual fit.
- `ProviderRegistry.create()` must happen after `registerOpenAI()`.
- The provider also implements `listModels()` and `healthCheck()`, which can be useful for app diagnostics or admin flows.

## 11. Common Errors

| Error | Meaning | Fix |
| --- | --- | --- |
| `Unsupported provider type: openai` | registration never happened | call `registerOpenAI()` before `ProviderRegistry.create()` |
| missing API key error | `apiKey` not provided | set `OPENAI_API_KEY` and pass it into the config |
| model required error | no default model and no per-call model | set `model` in config or pass `params.model` |
| duplicate provider registration | provider was registered twice | register once, or intentionally pass `{ replace: true }` |
| `ProviderRequestError` with `kind: 'auth'` | key rejected (401/403) | terminal — not retried. Check the key |
| `ProviderRequestError` with `kind: 'throttle'` | rate limited (429) | retried automatically inside an agent run; honor `retryAfterMs` on direct calls |

## Related

- [Providers Overview](./README.md)
- [Provider Selection Guide](./selection-guide.md)
- [HTTP Provider](./http.md)
- [Provider Registry](../sdk/provider-integration/registry.md)
- [Reliability and Cancellation](../sdk/runtime/reliability.md)
- [SDK Quickstart](../sdk/quickstart.md)
- [OpenAI Provider Entry](https://github.com/cogitave/namzu/blob/main/packages/providers/openai/src/index.ts)
- [OpenAI Config Types](https://github.com/cogitave/namzu/blob/main/packages/providers/openai/src/types.ts)
