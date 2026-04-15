# @namzu/openai

[OpenAI](https://platform.openai.com) LLM provider for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk). Thin wrapper around the official [`openai`](https://www.npmjs.com/package/openai) npm SDK exposing the **Chat Completions API** (chat + streaming) with full tool-use / function-calling support, conformant to the `LLMProvider` contract.

## Install

```bash
pnpm add @namzu/sdk @namzu/openai
```

`@namzu/openai` declares `@namzu/sdk` as a peer dependency. Install both.

## Usage

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOpenAI } from '@namzu/openai'

// Register once at app startup.
registerOpenAI()

// Fully typed via module augmentation: ProviderConfigRegistry['openai'].
const { provider, capabilities } = ProviderRegistry.create({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini', // optional default — can also be passed per-call
})

const response = await provider.chat({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello' }],
})
```

Streaming:

```ts
for await (const chunk of provider.chatStream({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Tell me a story' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

## Configuration

| Field            | Description                                                                  | Default                         |
|------------------|------------------------------------------------------------------------------|---------------------------------|
| `apiKey`         | OpenAI API key (required)                                                    | —                               |
| `model`          | Default model identifier (overridable per-call via `ChatCompletionParams.model`) | — |
| `baseURL`        | Override the base URL (Azure OpenAI, Enterprise endpoints, OpenAI-compat)    | `https://api.openai.com/v1`     |
| `organization`   | OpenAI Organization ID                                                       | —                               |
| `project`        | OpenAI Project ID                                                            | —                               |
| `timeout`        | Request timeout in ms                                                        | SDK default (600_000)           |
| `defaultHeaders` | Custom headers appended to every request                                     | —                               |

## Compatibility

Setting `baseURL` makes this provider work against any OpenAI-compatible endpoint — Azure OpenAI (with the appropriate deployment URL), self-hosted gateways, Enterprise endpoints, or local OpenAI-compatible servers.

For Azure OpenAI specifically, you can also use the official `openai` SDK's `AzureOpenAI` constructor directly; this package currently only exposes the base `OpenAI` client. For generic OpenAI-compat backends (Ollama, vLLM, LM Studio's HTTP endpoint), [`@namzu/http`](https://www.npmjs.com/package/@namzu/http) with `dialect: 'openai'` is the zero-dependency alternative.

## Capabilities

```ts
import { OPENAI_CAPABILITIES } from '@namzu/openai'

// {
//   supportsTools: true,
//   supportsStreaming: true,
//   supportsFunctionCalling: true,
// }
```

## Observability

This package ships without observability hooks in `0.1.x`. OpenTelemetry span emission and structured logging are roadmapped for the forthcoming `@namzu/telemetry` package — a separate opt-in dependency that wraps any `LLMProvider` to emit GenAI semantic-convention spans. Track progress in the [Namzu roadmap](https://github.com/cogitave/namzu).

## License

FSL-1.1-MIT. Same as `@namzu/sdk`.
