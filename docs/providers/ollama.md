---
title: Ollama Provider
description: Configure @namzu/ollama for local Ollama-based model execution in Namzu.
last_updated: 2026-08-03
status: current
related_packages: ["@namzu/sdk", "@namzu/ollama"]
---

# Ollama Provider

`@namzu/ollama` is the local-first provider package for an Ollama daemon. It is a direct fit when your Namzu runtime should stay close to locally hosted open models.

## 1. When to Use It

Choose this package when Ollama is the runtime you actually want to operate, not just an endpoint you happen to expose over a compatible HTTP interface.

## 2. When Not to Use It

Choose another provider when:

- you only need the OpenAI-compatible Ollama endpoint and want the most generic abstraction, where [`@namzu/http`](./http.md) may be enough
- your local workflow is based on LM Studio rather than Ollama

## 3. Install

```bash
pnpm add @namzu/sdk @namzu/ollama
```

## 4. Prerequisites

Before using the provider:

- run the Ollama daemon
- pull the model you plan to use
- confirm the host if not using the default

## 5. Register and Create the Provider

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOllama } from '@namzu/ollama'

registerOllama()

const { provider, capabilities } = ProviderRegistry.create({
  type: 'ollama',
  host: 'http://localhost:11434',
  model: 'llama3.2',
})
```

## 6. Sanity-Check With a Direct Provider Call

```ts
const response = await provider.chat({
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
})

console.log(response.message.content)
```

## 7. Configuration

| Field | Required | Description |
| --- | --- | --- |
| `host` | No | Ollama base URL; defaults to `OLLAMA_HOST` or the local default |
| `fetch` | No | Custom `fetch` implementation |
| `model` | No | Default model when omitted from chat params |
| `timeout` | No | Reserved timeout field for the provider config |

## 8. Capability Snapshot

The package exports `OLLAMA_CAPABILITIES`:

```ts
{
  supportsTools: true,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsVision: true,
  supportsDocuments: false,
}
```

These flags describe the DRIVER, not the model. The driver sends tool schemas, reassembles calls off the stream, replays an assistant turn's own calls with their arguments, and carries image attachments as image bytes.

Whether the model you loaded was trained to call tools or to see images is a separate question the daemon does not report. A model that cannot call tools simply will not, and the run proceeds as a text turn.

## 9. Operational Notes

- An Ollama daemon and at least one pulled model must already be available.
- Tool results are bound to their call by tool NAME on this wire, not by call id; the driver resolves the name from the assistant turn that made the call.
- An image whose media type the daemon cannot decode would fail the whole request, so an unrecognised format is named in the text instead of being sent as bytes.
- Reasoning is requested only when the caller asks for it, and reasoning the model produced is replayed back on the next turn.
- If you prefer a generic OpenAI-compatible path over the Ollama-specific package, [`@namzu/http`](./http.md) can target the Ollama HTTP endpoint instead.
- The provider also implements `listModels()` and `healthCheck()`.

## 10. Common Errors

| Error | Meaning | Fix |
| --- | --- | --- |
| `Unsupported provider type: ollama` | registration never happened | call `registerOllama()` first |
| model required error | no default model and no per-call model | set `model` in config or per call |
| connection failures | daemon is not running or host is wrong | start Ollama and verify `host` |

## Related

- [Providers Overview](./README.md)
- [Provider Selection Guide](./selection-guide.md)
- [HTTP Provider](./http.md)
- [Provider Registry](../sdk/provider-integration/registry.md)
- [Ollama Provider Entry](https://github.com/cogitave/namzu/blob/main/packages/providers/ollama/src/index.ts)
- [Ollama Config Types](https://github.com/cogitave/namzu/blob/main/packages/providers/ollama/src/types.ts)
