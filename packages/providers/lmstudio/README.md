# @namzu/lmstudio

[LM Studio](https://lmstudio.ai) LLM provider for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk). Thin wrapper around the official [`@lmstudio/sdk`](https://www.npmjs.com/package/@lmstudio/sdk) that conforms to the `LLMProvider` contract (chat + streaming). Run any open-weights model locally through LM Studio's GUI-managed server.

## Install

```bash
pnpm add @namzu/sdk @namzu/lmstudio
```

`@namzu/lmstudio` declares `@namzu/sdk` as a peer dependency. Install both.

## Prerequisites

Requires [LM Studio](https://lmstudio.ai) running as a local server (default `http://localhost:1234`, transported over WebSocket by the official SDK). Load a model via LM Studio's UI or the CLI:

```bash
lms load <model>
```

Start the local server from LM Studio's **Developer** tab (or `lms server start`).

## Usage

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerLMStudio } from '@namzu/lmstudio'

// Register once at app startup.
registerLMStudio()

// Fully typed via module augmentation: ProviderConfigRegistry['lmstudio'].
const { provider, capabilities } = ProviderRegistry.create({
  type: 'lmstudio',
  host: 'http://localhost:1234', // optional — defaults to LM Studio's auto-detection or LMSTUDIO_HOST env var. Accepts http(s) (auto-converted to ws(s) for the SDK).
  model: 'llama-3.2-1b-instruct', // optional default — can also be passed per-call
})

const response = await provider.chat({
  model: 'llama-3.2-1b-instruct',
  messages: [{ role: 'user', content: 'Hello' }],
})
```

Streaming:

```ts
for await (const chunk of provider.chatStream({
  model: 'llama-3.2-1b-instruct',
  messages: [{ role: 'user', content: 'Tell me a story' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

## Configuration

| Field     | Description                                                                 | Default                      |
|-----------|-----------------------------------------------------------------------------|------------------------------|
| `host`    | LM Studio server URL (`http://…` accepted, converted to `ws://…`)           | Auto-detected by `@lmstudio/sdk` or `LMSTUDIO_HOST` |
| `model`   | Default model identifier (overridable per-call via `ChatCompletionParams.model`) | — |
| `timeout` | Request timeout in ms                                                       | SDK default                  |

The model identifier must match a model **already loaded** in LM Studio. Use `lms ls` or the LM Studio UI to discover loaded models; `provider.listModels()` returns loaded models via the SDK's `listLoaded()`.

## Transport

Uses the official `@lmstudio/sdk` (WebSocket). This unlocks richer local-model features than the OpenAI-compat HTTP endpoint — the SDK is built for local-LLM workflows (loading/unloading, configuration, speculative decoding). If you prefer zero-dep HTTP instead, use [`@namzu/http`](https://www.npmjs.com/package/@namzu/http) with `baseURL: 'http://<host>/v1'` and `dialect: 'openai'`.

## Capabilities

```ts
import { LMSTUDIO_CAPABILITIES } from '@namzu/lmstudio'

// {
//   supportsTools: true,
//   supportsStreaming: true,
//   supportsFunctionCalling: true,
// }
```

Tool-use support depends on the loaded model — not every open-weights model has been tuned for function calling. Refer to the model's card in LM Studio.

## Observability

This package ships without observability hooks in `0.1.x`. OpenTelemetry span emission and structured logging are roadmapped for the forthcoming `@namzu/telemetry` package — a separate opt-in dependency that wraps any `LLMProvider` to emit GenAI semantic-convention spans. Track progress in the [Namzu roadmap](https://github.com/cogitave/namzu).

## License

FSL-1.1-MIT. Same as `@namzu/sdk`.
