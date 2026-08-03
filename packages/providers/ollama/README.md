# @namzu/ollama

Ollama LLM provider for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk). Local-first LLM support — run Llama, Mistral, Phi, and 100+ open models on your own hardware via the official [`ollama`](https://www.npmjs.com/package/ollama) client, conformant to the `LLMProvider` contract.

## Prerequisites

Requires the **Ollama daemon** ([https://ollama.com](https://ollama.com)) running locally or at a configured host. Install Ollama, pull a model (`ollama pull llama3.2`), and ensure the daemon is reachable (default `http://localhost:11434`).

## Install

```bash
pnpm add @namzu/sdk @namzu/ollama
```

`@namzu/ollama` declares `@namzu/sdk` as a peer dependency. Install both.

## Usage

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOllama } from '@namzu/ollama'

// Register once at app startup.
registerOllama()

// Fully typed via module augmentation: ProviderConfigRegistry['ollama'].
const { provider, capabilities } = ProviderRegistry.create({
  type: 'ollama',
  host: 'http://localhost:11434', // optional; defaults to OLLAMA_HOST env or localhost
  model: 'llama3.2',              // default model when none is specified per-call
})

const response = await provider.chat({
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'Hello' }],
})
```

Streaming:

```ts
for await (const chunk of provider.chatStream({
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'Tell me a story' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

## Configuration

| Option    | Type                | Default                                       | Description                                    |
| --------- | ------------------- | --------------------------------------------- | ---------------------------------------------- |
| `host`    | `string`            | `OLLAMA_HOST` env var or `http://localhost:11434` | Ollama daemon base URL.                    |
| `model`   | `string`            | —                                             | Default model when `params.model` is omitted.  |
| `fetch`   | `typeof fetch`      | global `fetch`                                | Custom fetch (e.g. to inject auth headers).    |
| `timeout` | `number` (ms)       | —                                             | Reserved; not currently enforced by the client. |

## Capabilities

```ts
import { OLLAMA_CAPABILITIES } from '@namzu/ollama'

// {
//   supportsTools: false,            // varies by model — conservative default
//   supportsStreaming: true,
//   supportsFunctionCalling: false,
// }
```

Ollama's tool-use support varies by model. The default is `false`; if you target a tool-capable model (e.g. `llama3.1`, `mistral-nemo`), pass `{ replace: true }` with custom capabilities, or consume tool output yourself at the call site.

## Observability

This package ships without observability hooks in `0.1.x`. OpenTelemetry span emission and structured logging are roadmapped for the forthcoming `@namzu/telemetry` package — a separate opt-in dependency that wraps any `LLMProvider` to emit GenAI semantic-convention spans.

## License

FSL-1.1-MIT. Same as `@namzu/sdk`.
