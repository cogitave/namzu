# @namzu/openrouter

OpenRouter LLM provider for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk). Thin `fetch`-based wrapper around OpenRouter's **OpenAI-compatible Chat Completions API** (chat + streaming) with full tool-use support, conformant to the `LLMProvider` contract. Gives you access to 200+ models — Claude, GPT-4, Llama, Mixtral, Gemini, and more — through a single unified API and billing account.

## Install

```bash
pnpm add @namzu/sdk @namzu/openrouter
```

`@namzu/openrouter` declares `@namzu/sdk` as a peer dependency. Install both. The provider has **zero runtime dependencies** — it talks to OpenRouter with native `fetch`.

## Usage

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOpenRouter } from '@namzu/openrouter'

// Register once at app startup.
registerOpenRouter()

// Fully typed via module augmentation: ProviderConfigRegistry['openrouter'].
const { provider, capabilities } = ProviderRegistry.create({
  type: 'openrouter',
  apiKey: process.env.OPENROUTER_API_KEY!,
  siteUrl: 'https://myapp.example',   // optional — shown on OpenRouter analytics
  siteName: 'My App',                 // optional — shown on OpenRouter analytics
})

const response = await provider.chat({
  model: 'anthropic/claude-sonnet-4',
  messages: [{ role: 'user', content: 'Hello' }],
})
```

Streaming:

```ts
for await (const chunk of provider.chatStream({
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: 'Tell me a story' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

## Authentication

Get an API key at [openrouter.ai/keys](https://openrouter.ai/keys). Pass it to the provider via the `apiKey` field, or read it from `process.env.OPENROUTER_API_KEY` in your app before constructing the config.

## Models

OpenRouter exposes 200+ models from every major vendor under one unified API. See the [OpenRouter model catalog](https://openrouter.ai/models) for the full list and current pricing. Identifiers follow the `vendor/model-name` pattern:

- `anthropic/claude-sonnet-4`
- `anthropic/claude-haiku-4`
- `openai/gpt-4o`
- `openai/gpt-4o-mini`
- `meta-llama/llama-3.3-70b-instruct`
- `mistralai/mixtral-8x22b-instruct`
- `google/gemini-pro-1.5`

Pricing is per-million tokens on OpenRouter's catalog — the provider's `listModels()` returns live pricing pulled from the `/models` endpoint.

## Base URL override

The OpenRouter endpoint defaults to `https://openrouter.ai/api/v1`. Override via the `baseUrl` config field or the `OPENROUTER_BASE_URL` environment variable — useful for OpenRouter-compatible self-hosted gateways.

## Capabilities

```ts
import { OPENROUTER_CAPABILITIES } from '@namzu/openrouter'

// {
//   supportsTools: true,
//   supportsStreaming: true,
//   supportsFunctionCalling: true,
// }
```

## OpenAI compatibility

Because OpenRouter speaks the OpenAI Chat Completions dialect, this provider can also target any OpenAI-compatible endpoint (vLLM, LM Studio, Groq, local OpenAI-compat gateways) by passing `baseUrl` pointing at the alternate endpoint. For a zero-config generic OpenAI-compatible client, use the forthcoming `@namzu/http` package instead.

## Observability

This package ships without observability hooks in `0.1.x`. OpenTelemetry span emission and structured logging are roadmapped for the forthcoming `@namzu/telemetry` package — a separate opt-in dependency that wraps any `LLMProvider` to emit GenAI semantic-convention spans. Track progress in the [Namzu roadmap](https://github.com/cogitave/namzu).

## License

FSL-1.1-MIT. Same as `@namzu/sdk`.
