---
title: Anthropic Provider
description: Configure @namzu/anthropic for the Anthropic Messages API through Namzu, including per-model thinking and effort resolution.
last_updated: 2026-08-05
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
| `strictToolUse` | No | Constrained tool-input policy: `auto` (default), `on`, or `off` |

## 8. Thinking and Effort

`thinking` and `effort` are set on the run, not on the provider — see
[Run Configuration](../sdk/runtime/configuration.md). What this driver adds is
resolving them **per model**, because the same request body is accepted by one
model and rejected outright by its sibling.

### 8.1 Thinking mode is resolved, never passed through

Three modes exist, and a model accepts some subset of them:

| Mode | Meaning |
| --- | --- |
| `adaptive` | the model decides whether and how deeply to reason; depth is steered by `effort` |
| `enabled` | manual: `budgetTokens` fixes the depth and the model reasons on every request |
| `disabled` | no reasoning |

Newer models refuse `enabled`, older ones refuse `adaptive`, and some refuse
`disabled` because they cannot stop reasoning at all. Sending the wrong one
produces a failed request, not a worse answer — so what you set is a declared
intent, and the driver resolves it against the model it is about to call.

The one asymmetry worth knowing: **a `disabled` request on a model that cannot
stop reasoning omits the field rather than throwing.** Turning something off is
not a request that can be refused, and a config that spans several models should
not fail on the ones that were never going to reason anyway.

### 8.2 Which effort levels a model takes is a set, not a ladder

`effort` is `low | medium | high | xhigh | max`, and it is tempting to read
those as rungs where anything accepting the top accepts the one below. **They
are not.** A model can take `max` and refuse `xhigh`, and reading them as a
ladder is what previously put a level on a capability row that the wire rejects.

The driver keeps two sets per model — the levels accepted generally, and the
levels accepted *with thinking off*. On most models those two are identical; on
one family they are not, which is why they are separate rows rather than one
blanket rule. An earlier blanket rule discarded `xhigh` and `max` whenever
thinking was off, on the reasoning that the pairing is incoherent — and
measurement showed one family rejects it while its siblings accept and honour
it. Looking incoherent is not the same as being rejected, and only the wire
decides which.

**A level the model does not accept is dropped rather than sent**, because
effort shapes an answer the model will still produce. A *mode* the model does
not accept is a different matter and fails the request, because there is no
answer to shape.

### 8.3 `output_config` is merged, not assigned

`effort` travels in a shared envelope on this wire, alongside a
structured-output format and a task budget. The driver merges into it. If you
are extending this driver, keep it that way: assigning means whoever wires the
next field silently deletes effort, or has effort delete theirs, depending only
on which line runs last.

## 9. Capability Snapshot

The package exports `ANTHROPIC_CAPABILITIES`:

```ts
{
  supportsTools: true,
  supportsStreaming: true,
  supportsFunctionCalling: true,
}
```

## 10. Operational Notes

- Anthropic requires `max_tokens`, so setting `maxTokens` at provider creation time is a good default.
- In `auto` mode, tools marked with `enforceModelInput: true` are sent with `strict: true` on recognized Claude 4.5+ model identifiers. Use `on` only for a compatible proxy alias, or `off` to disable constrained tool inputs.
- Strict generation narrows model output, but `ToolRegistry` still applies the tool's runtime Zod schema before execution.
- `baseURL` can point at proxies or gateways, but for Bedrock-hosted Anthropic models [`@namzu/bedrock`](./bedrock.md) is the better fit.
- The provider also implements `listModels()` and `healthCheck()`.

## 11. Common Errors

| Error | Meaning | Fix |
| --- | --- | --- |
| `Unsupported provider type: anthropic` | registration never happened | call `registerAnthropic()` before `create()` |
| missing API key error | `apiKey` not provided | pass a valid Anthropic API key |
| tool-rich calls fail unexpectedly | `max_tokens` handling was overlooked in direct calls | set `maxTokens` at provider creation or per call |

## Related

- [Providers Overview](./README.md)
- [Provider Selection Guide](./selection-guide.md)
- [Run Configuration](../sdk/runtime/configuration.md)
- [Loop Control and Resilience](../sdk/runtime/loop-control.md)
- [Bedrock Provider](./bedrock.md)
- [HTTP Provider](./http.md)
- [Provider Registry](../sdk/provider-integration/registry.md)
- [Anthropic Provider Entry](https://github.com/cogitave/namzu/blob/main/packages/providers/anthropic/src/index.ts)
- [Anthropic Config Types](https://github.com/cogitave/namzu/blob/main/packages/providers/anthropic/src/types.ts)
