# @namzu/anthropic

Anthropic LLM provider for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk). Thin wrapper around the official [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk) exposing Anthropic's **Messages API** (chat + streaming) with full tool-use support, conformant to the `LLMProvider` contract.

## Install

```bash
pnpm add @namzu/sdk @namzu/anthropic
```

`@namzu/anthropic` declares `@namzu/sdk` as a peer dependency. Install both.

## Usage

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerAnthropic } from '@namzu/anthropic'

// Register once at app startup.
registerAnthropic()

// Fully typed via module augmentation: ProviderConfigRegistry['anthropic'].
const { provider, capabilities } = ProviderRegistry.create({
  type: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-4-5-20250929',
})

const response = await provider.chat({
  model: 'claude-sonnet-4-5-20250929',
  messages: [{ role: 'user', content: 'Hello' }],
  maxTokens: 1024,
})
```

Streaming:

```ts
for await (const chunk of provider.chatStream({
  model: 'claude-sonnet-4-5-20250929',
  messages: [{ role: 'user', content: 'Tell me a story' }],
  maxTokens: 1024,
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

## Authentication

Pass your Anthropic API key via the config object:

```ts
registerAnthropic()
ProviderRegistry.create({
  type: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
})
```

Get a key at <https://console.anthropic.com/settings/keys>. Conventionally set it as the `ANTHROPIC_API_KEY` environment variable.

### Custom endpoints

Override `baseURL` to route through a proxy, a self-hosted gateway, or an Anthropic-compatible endpoint. For AWS Bedrock or Google Vertex access, prefer the dedicated `@namzu/bedrock` / Vertex provider over `baseURL` overrides — they handle auth and region semantics natively.

```ts
ProviderRegistry.create({
  type: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  baseURL: 'https://anthropic-proxy.example.com',
  defaultHeaders: { 'x-team': 'platform' },
  timeout: 120_000,
})
```

### Max tokens

Anthropic's Messages API **requires** `max_tokens`. This provider defaults to `4096` when neither `params.maxTokens` nor `config.maxTokens` is set. Configure a default at registration time:

```ts
ProviderRegistry.create({
  type: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  maxTokens: 8192,
})
```

## Capabilities

```ts
import { ANTHROPIC_CAPABILITIES } from '@namzu/anthropic'

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
