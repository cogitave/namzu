# @namzu/http

**Zero-dependency** LLM provider for any OpenAI- or Anthropic-compatible HTTP endpoint. Pure `fetch` — no third-party SDK coupling. Use this when you want to talk to a self-hosted inference server, a niche endpoint without a dedicated provider package, or you simply prefer no extra dependencies.

Works against: **vLLM**, **TGI**, **llama-server**, **Groq**, **DeepInfra**, **Together.ai**, **Ollama** (OpenAI-compat endpoint), **LM Studio**, **OpenAI**, **Anthropic** (native Messages API), or any server that speaks the same wire shape.

## Install

```bash
pnpm add @namzu/sdk @namzu/http
```

`@namzu/http` declares `@namzu/sdk` as a peer dependency. Install both. Runtime deps: **zero**.

## Usage

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerHttp } from '@namzu/http'

// Register once at app startup.
registerHttp()
```

### OpenAI via HTTP

```ts
const { provider } = ProviderRegistry.create({
  type: 'http',
  baseURL: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY!,
  dialect: 'openai', // default
})

await provider.chat({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello' }],
})
```

### Anthropic native Messages API

```ts
const { provider } = ProviderRegistry.create({
  type: 'http',
  baseURL: 'https://api.anthropic.com/v1',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  dialect: 'anthropic',
})

await provider.chat({
  model: 'claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'Hello' }],
  maxTokens: 1024, // REQUIRED for Anthropic
})
```

### Local Ollama (OpenAI-compat endpoint)

Prefer this over `@namzu/ollama` when you don't want the extra package.

```ts
const { provider } = ProviderRegistry.create({
  type: 'http',
  baseURL: 'http://localhost:11434/v1',
  dialect: 'openai',
  model: 'llama3.2', // default model when params omit it
})
```

### Self-hosted vLLM

```ts
const { provider } = ProviderRegistry.create({
  type: 'http',
  baseURL: 'http://my-vllm-server:8000/v1',
  apiKey: 'optional-gateway-token',
  dialect: 'openai',
})
```

### Groq, DeepInfra, Together.ai

```ts
const { provider } = ProviderRegistry.create({
  type: 'http',
  baseURL: 'https://api.groq.com/openai/v1',
  apiKey: process.env.GROQ_API_KEY!,
  dialect: 'openai',
})
```

### Custom headers

```ts
ProviderRegistry.create({
  type: 'http',
  baseURL: 'https://my-gateway.example/v1',
  dialect: 'openai',
  headers: {
    'X-Custom-Tenant': 'team-42',
  },
})
```

## Dialect mismatch

If you declare `dialect: 'openai'` but hit an Anthropic-shape endpoint (or vice versa), `HttpProvider` throws `DialectMismatchError` — **fail-fast, no auto-detection**. The error carries the URL, HTTP status, and a truncated sample of the response body.

```ts
import { DialectMismatchError } from '@namzu/http'

try {
  await provider.chat({ model, messages })
} catch (err) {
  if (err instanceof DialectMismatchError) {
    console.error('Wrong dialect:', err.url, err.status, err.sample)
  }
}
```

This is deliberate. Silent coercion between shapes would corrupt tool-call arguments and content deltas. Picking the right `dialect` is a one-line config decision — the failure mode is immediate and actionable.

## Streaming

```ts
for await (const chunk of provider.chatStream({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Tell me a story' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

Both dialects stream SSE:

- **`openai`** — parses `data: {...}` frames terminated by `data: [DONE]`.
- **`anthropic`** — parses `message_start` / `content_block_start` / `content_block_delta` / `message_delta` / `message_stop` events and maps them into the sdk's normalized `StreamChunk`.

## Capabilities

```ts
import { HTTP_CAPABILITIES } from '@namzu/http'

// {
//   supportsTools: true,
//   supportsStreaming: true,
//   supportsFunctionCalling: true,
// }
```

Actual tool-use support depends on the **endpoint**, not this package. Some self-hosted servers do not implement the `tools` parameter correctly — if in doubt, test against your server first.

## Observability

This package ships without observability hooks in `0.1.x`. OpenTelemetry span emission and structured logging are roadmapped for the forthcoming `@namzu/telemetry` package — a separate opt-in dependency that wraps any `LLMProvider` to emit GenAI semantic-convention spans. Track progress in the [Namzu roadmap](https://github.com/cogitave/namzu).

## License

FSL-1.1-MIT. Same as `@namzu/sdk`.
