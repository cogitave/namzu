---
title: LM Studio Provider
description: Configure @namzu/lmstudio for local LM Studio server usage in Namzu.
last_updated: 2026-08-03
status: current
related_packages: ["@namzu/sdk", "@namzu/lmstudio"]
---

# LM Studio Provider

`@namzu/lmstudio` integrates Namzu with LM Studio through the official LM Studio SDK. It is aimed at local-model workflows where LM Studio is the operator-facing environment.

## 1. When to Use It

Choose this package when LM Studio is already the way you manage and serve local models, and you want a provider that matches that environment directly.

## 2. When Not to Use It

Choose another provider when:

- you want generic HTTP compatibility over LM Studio's native SDK behavior
- you are running local models through Ollama instead of LM Studio

## 3. Install

```bash
pnpm add @namzu/sdk @namzu/lmstudio
```

## 4. Prerequisites

Before creating the provider:

- start the LM Studio local server
- load the model you plan to use
- confirm the server host if you are not using the default

## 5. Register and Create the Provider

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerLMStudio } from '@namzu/lmstudio'

registerLMStudio()

const { provider, capabilities } = ProviderRegistry.create({
  type: 'lmstudio',
  host: 'http://localhost:1234',
  model: 'llama-3.2-1b-instruct',
})
```

## 6. Sanity-Check With a Direct Provider Call

```ts
const response = await provider.chat({
  model: 'llama-3.2-1b-instruct',
  messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
})

console.log(response.message.content)
```

## 7. Configuration

| Field | Required | Description |
| --- | --- | --- |
| `host` | No | LM Studio server URL |
| `model` | No | Default loaded model identifier |
| `timeout` | No | Request timeout in milliseconds |
| `client` | No | An already-connected backend client to use instead of dialing a new one |

## 8. Capability Snapshot

The package exports `LMSTUDIO_CAPABILITIES`:

```ts
{
  supportsTools: true,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsVision: true,
  supportsDocuments: false,
}
```

The driver sends tool schemas, maps the conversation onto the backend's native part structure — the assistant's own calls and each result as first-class parts rather than text folded into a user turn — and surfaces calls as the backend parses them.

An image cannot be inlined on this wire, so each user attachment is uploaded to the backend first and the message references the handle that comes back. An upload that fails leaves a text note naming the image rather than taking the turn down. An image inside a **tool result** stays a text placeholder: a tool message here may hold result parts and nothing else, so there is nowhere to reference a handle from.

Whether the loaded model was trained to call tools is a separate question; these flags describe the driver.

## 9. Operational Notes

- The target model must already be loaded in LM Studio.
- This package uses the official LM Studio SDK rather than the OpenAI-compatible HTTP endpoint.
- If you want a more generic HTTP-only integration, [`@namzu/http`](./http.md) can target LM Studio's compatible endpoint instead.
- `host` accepts `http://` or `https://`, but the SDK converts it to the WebSocket form it needs internally.
- The provider also implements `listModels()` and `healthCheck()`.

## 10. Common Errors

| Error | Meaning | Fix |
| --- | --- | --- |
| `Unsupported provider type: lmstudio` | registration never happened | call `registerLMStudio()` first |
| model required error | neither provider config nor call supplied a model | set a default model or pass one per call |
| model not found or unloaded | LM Studio server is up but the model is not loaded | load the model first in LM Studio |

## Related

- [Providers Overview](./README.md)
- [Provider Selection Guide](./selection-guide.md)
- [HTTP Provider](./http.md)
- [Provider Registry](../sdk/provider-integration/registry.md)
- [LM Studio Provider Entry](https://github.com/cogitave/namzu/blob/main/packages/providers/lmstudio/src/index.ts)
- [LM Studio Config Types](https://github.com/cogitave/namzu/blob/main/packages/providers/lmstudio/src/types.ts)
