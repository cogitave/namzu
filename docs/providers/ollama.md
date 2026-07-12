---
title: Ollama Provider
description: Configure @namzu/ollama for local Ollama-based model execution in Namzu.
last_updated: 2026-07-12
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
  supportsTools: false,
  supportsStreaming: true,
  supportsFunctionCalling: false,
  supportsAbortSignal: false,
}
```

That conservative declaration is intentional. Actual tool support varies by model and should not be assumed globally.

## 9. Error Handling and Cancellation

`chat()` and `chatStream()` failures are normalized to the SDK's `ProviderRequestError` with a runtime-classifiable `kind` — `throttle`, `context_overflow`, `auth`, `bad_request`, `server`, `network`, `aborted`, or `unknown`. A stopped daemon (connection refused, socket error) surfaces as `kind: 'network'`, which is retryable, rather than as an opaque failure. HTTP status maps through the SDK's shared `classifyHttpStatus`.

`finishReason` now reflects the vendor's `done_reason`. Previously it was hardcoded to `stop`, which meant a truncated response was indistinguishable from a complete one; `'length'` is now preserved and the runtime can react to it.

### Cancellation is limited on the non-streaming path

**`supportsAbortSignal` is `false`.** The official `ollama` client's non-streaming `chat()` exposes no `AbortSignal` path, so an in-flight, non-streaming request **cannot be cancelled mid-flight**. Passing `params.signal` only rejects a request that was *already* aborted before dispatch; otherwise cancellation takes effect at the next iteration boundary.

The **streaming path is cancellable**: `chatStream()` forwards `params.signal` to the vendor iterator's `.abort()` on a best-effort basis.

If a cancelled run has to stop within a bounded time on Ollama, prefer the streaming path — or use [`@namzu/http`](./http.md) against the Ollama endpoint, which is fetch-based and fully abortable.

See [Reliability and Cancellation](../sdk/runtime/reliability.md).

## 10. Operational Notes

- An Ollama daemon and at least one pulled model must already be available.
- The exported `OLLAMA_CAPABILITIES` constant is conservative and reports tool support as `false` by default because tool behavior depends on the chosen model.
- If you prefer a generic OpenAI-compatible path over the Ollama-specific package, [`@namzu/http`](./http.md) can target the Ollama HTTP endpoint instead.
- The provider also implements `listModels()` and `healthCheck()`.

## 11. Common Errors

| Error | Meaning | Fix |
| --- | --- | --- |
| `Unsupported provider type: ollama` | registration never happened | call `registerOllama()` first |
| model required error | no default model and no per-call model | set `model` in config or per call |
| connection failures | daemon is not running or host is wrong | start Ollama and verify `host` |
| `ProviderRequestError` with `kind: 'network'` | daemon is down or unreachable | start Ollama. Retried automatically inside an agent run |
| a cancel does not stop the current request | non-streaming `chat()` cannot be aborted | use the streaming path, or `@namzu/http` |

## Related

- [Providers Overview](./README.md)
- [Provider Selection Guide](./selection-guide.md)
- [HTTP Provider](./http.md)
- [Provider Registry](../sdk/provider-integration/registry.md)
- [Reliability and Cancellation](../sdk/runtime/reliability.md)
- [Ollama Provider Entry](https://github.com/cogitave/namzu/blob/main/packages/providers/ollama/src/index.ts)
- [Ollama Config Types](https://github.com/cogitave/namzu/blob/main/packages/providers/ollama/src/types.ts)
