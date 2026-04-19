---
title: Provider Registry
description: How provider packages register with ProviderRegistry, how to create providers safely, and how to hand them into agents.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk", "@namzu/openai", "@namzu/anthropic", "@namzu/bedrock", "@namzu/openrouter", "@namzu/http", "@namzu/ollama", "@namzu/lmstudio"]
---

# Provider Registry

`ProviderRegistry` is the stable provider boundary inside `@namzu/sdk`. Every published provider package registers itself into this registry, and every agent run receives an `LLMProvider` instance created through the same API.

## 1. Why the Registry Exists

The registry solves three problems:

- provider packages can live outside the SDK without changing agent code
- application code can stay vendor-neutral after initial registration
- the runtime can depend on one `LLMProvider` contract instead of branching on vendors

The result is a consistent pattern:

1. install `@namzu/sdk` and one provider package
2. call the provider package's `register...()` function once
3. create a provider through `ProviderRegistry.create(...)`
4. pass the returned `provider` into a `ReactiveAgent` or call `provider.chat()` directly

## 2. The Registration Flow

Each provider package exports a registration helper:

| Package | Registration helper | Registry `type` |
| --- | --- | --- |
| `@namzu/openai` | `registerOpenAI()` | `openai` |
| `@namzu/anthropic` | `registerAnthropic()` | `anthropic` |
| `@namzu/bedrock` | `registerBedrock()` | `bedrock` |
| `@namzu/openrouter` | `registerOpenRouter()` | `openrouter` |
| `@namzu/http` | `registerHttp()` | `http` |
| `@namzu/ollama` | `registerOllama()` | `ollama` |
| `@namzu/lmstudio` | `registerLMStudio()` | `lmstudio` |

The helper wires three things into the SDK:

- a provider type string
- a provider constructor
- a capability declaration such as tool support and streaming support

## 3. Minimal Example

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOpenAI } from '@namzu/openai'

registerOpenAI()

const { provider, capabilities } = ProviderRegistry.create({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini',
})

console.log(capabilities.supportsTools)

const response = await provider.chat({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
})

console.log(response.message.content)
```

## 4. What `ProviderRegistry.create()` Returns

`ProviderRegistry.create(config)` returns:

- `provider`: the normalized `LLMProvider` instance used by the runtime
- `capabilities`: the package's declared capability flags

That capability object is useful when your application wants to make decisions such as:

- whether to expose tool-using agents on this backend
- whether to prefer streaming UI behavior
- whether a provider should be used for structured-output or function-calling tasks

## 5. ProviderRegistry API Surface

| Method | Purpose |
| --- | --- |
| `register(type, ctor, capabilities, options?)` | Register a provider package manually |
| `create(config)` | Create `{ provider, capabilities }` in one step |
| `createProvider(config)` | Create only the provider instance |
| `getCapabilities(type)` | Read declared capabilities for a provider type |
| `isSupported(type)` | Check if a provider type has been registered |
| `listTypes()` | List currently registered provider types |
| `unregister(type)` | Remove a provider registration |

Most applications only need `register...()` plus `ProviderRegistry.create(...)`.

## 6. Direct Provider Calls vs Agent Runtime

Direct provider calls are useful for:

- credential validation
- model smoke tests
- debugging provider-specific behavior
- building provider-aware tooling before adding agents

Once that succeeds, the usual next step is to hand the provider to an agent:

```ts
import {
  ProviderRegistry,
  ReactiveAgent,
  ToolRegistry,
  generateProjectId,
  generateSessionId,
  generateTenantId,
} from '@namzu/sdk'
import { registerOpenAI } from '@namzu/openai'

registerOpenAI()

const { provider } = ProviderRegistry.create({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini',
})

const agent = new ReactiveAgent({
  id: 'provider-registry-demo',
  name: 'Provider Registry Demo',
  version: '1.0.0',
  category: 'docs',
  description: 'Example agent for provider wiring documentation.',
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

## 7. Registration Lifetime

The recommended application pattern is:

- register each provider package once during app startup
- create provider instances as needed for runtime config, tenants, or per-request selection

Do not call `register...()` before every request. Registration is process-level catalog setup, not per-run work.

## 8. Common Errors

| Error | Meaning | Fix |
| --- | --- | --- |
| `Unsupported provider type` | The provider package was never registered | Call `registerOpenAI()` or the matching helper before `create()` |
| `Provider type "x" is already registered` | The same provider was registered twice | Register once, or pass `{ replace: true }` intentionally |
| provider-specific missing credential error | Required config such as `apiKey` was not supplied | Fix the package config before creating the provider |
| missing model error on `chat()` | Neither provider config nor `chat()` params supplied a model | Set a default model in config or pass `model` per call |

## 9. Optional Provider Methods

The `LLMProvider` contract always requires:

- `chat(params)`
- `chatStream(params)`

Most published providers also implement:

- `listModels()`
- `healthCheck()`

That makes the registry useful beyond agent runtime. You can use the same provider instance for:

- preflight health checks
- model catalog UI
- runtime readiness probes

Read [Provider Operations](./operations.md) if you want concrete direct-call patterns for those optional methods.

## 10. Related Decisions

Use the registry layer when:

- the provider should remain swappable
- your code should not import vendor SDKs directly
- you want one runtime flow across OpenAI, Anthropic, Bedrock, local models, and compatible HTTP endpoints

Skip the registry only if you are intentionally using a vendor SDK directly and not using Namzu's provider abstraction.

## Related

- [Getting Started](../../getting-started.md)
- [SDK Quickstart](../quickstart.md)
- [Provider Operations](./operations.md)
- [Run Identities](../runtime/identities.md)
- [Providers Overview](../../providers/README.md)
- [ProviderRegistry Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/provider/registry.ts)
