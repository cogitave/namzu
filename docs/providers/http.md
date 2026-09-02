---
title: The generic HTTP driver — two dialects and one configuration
description: Reference for @namzu/http: the two wire dialects it speaks and how a mismatch is refused rather than guessed, every configuration field, and the model-listing and health surfaces a gateway has to provide.
type: Reference
status: stable
resource: packages/providers/http/src/index.ts
tags: [provider, http, reference]
generated: { by: human:bahadirarda, at: 2026-08-21T00:00:00Z }
---

# The generic HTTP driver — two dialects and one configuration


Every other driver in this repository is named after the service it drives.
This one is named after the transport, because it has no service: you supply
the URL, and it speaks one of the two wires that most inference servers have
settled on.

`HttpProvider` implements the kernel's `LLMProvider` contract with one request.
In the OpenAI dialect that is `POST {baseURL}/chat/completions`; in the native
Anthropic dialect it is `POST {baseURL}/messages`. Both always send
`stream: true`. There is no non-streaming path, because the contract has no
non-streaming method — `chatStream` is the single model entry point, and a
caller who wants the whole answer collects the stream.

The transport is native `fetch` and nothing else. This package declares no
runtime dependencies at all: no vendor SDK, no HTTP client, no JSON tooling.
`@namzu/sdk` is a peer dependency (`>=6.0.0`), so your lockfile owns the kernel
version rather than this package.

Reach for it when the endpoint you have is a self-hosted inference server —
vLLM, TGI, llama-server — a gateway in front of one, a service without a
dedicated driver here, or a local daemon whose compatibility endpoint you would
rather use than install another package for. If there is a driver for your
service, prefer it: a driver that knows its vendor can answer questions this one
cannot, and the section on [models and health](#models-and-health) is a list of
exactly which.


## Use it

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerHttp } from '@namzu/http'

import type { Message } from '@namzu/sdk'

declare const messages: Message[]

registerHttp() // once, at startup

const { provider } = ProviderRegistry.create({
  type: 'http',
  baseURL: 'http://localhost:8000/v1',
  apiKey: process.env.INFERENCE_TOKEN ?? '',
  dialect: 'openai',
})

for await (const chunk of provider.chatStream({
  model: 'my-served-model',
  messages: [{ role: 'user', content: 'Hello' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

`registerHttp()` also carries the module augmentation that adds `'http'` to the
kernel's config union, so `ProviderRegistry.create({ type: 'http', … })` narrows
to `HttpProviderConfig` and a typo in the config is a compile error. Call it
twice and it throws `DuplicateProviderError`; pass `{ replace: true }` when you
mean to take the slot over.

`create()` hands back the driver's capability declaration alongside it, which is
the same object as [`HTTP_CAPABILITIES`](#capabilities):

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerHttp } from '@namzu/http'

registerHttp()

const { provider, capabilities } = ProviderRegistry.create({
  type: 'http',
  baseURL: 'http://localhost:8000/v1',
})
```

When you want the aggregated response rather than the deltas, collect the same
stream:

```ts
import { collectChatCompletion } from '@namzu/sdk'

import type { HttpProvider } from '@namzu/http'
import type { Message } from '@namzu/sdk'

declare const provider: HttpProvider
declare const messages: Message[]

const response = await collectChatCompletion(
  provider.chatStream({
    model: 'my-served-model',
    messages: [{ role: 'user', content: 'Hello' }],
  }),
)

console.log(response.message.content)
console.log(response.usage.totalTokens)
```

`listModels` and `healthCheck` are **optional** members of `LLMProvider`, so a
caller holding the interface has to guard them. Hold the class instead, where
they are ordinary methods:

```ts
import { HttpProvider } from '@namzu/http'

const driver = new HttpProvider({
  baseURL: 'http://localhost:8000/v1',
  dialect: 'openai',
})
```

The constructor throws when `baseURL` is missing. Everything else has a default.

## Two dialects

`dialect` decides the URL, the auth header and the shape of both the request and
the stream. It defaults to `'openai'`, and it is never inferred.

| | `'openai'` (default) | `'anthropic'` |
|---|---|---|
| Endpoint | `{baseURL}/chat/completions` | `{baseURL}/messages` |
| Auth header | `Authorization: Bearer {apiKey}` | `x-api-key: {apiKey}`, plus `anthropic-version: 2023-06-01` |
| Stream frames | `data: {…}` lines, ending at `data: [DONE]` | `message_start`, `content_block_start`, `content_block_delta`, `message_delta`, `message_stop` |
| System messages | sent as `system`-role messages | joined with a blank line into the top-level `system` field |
| `max_tokens` | sent only if you set `maxTokens` | always sent; `4096` when you set nothing |

The OpenAI dialect is the one to use for a self-hosted server or a gateway,
which is most of why this package exists:

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerHttp } from '@namzu/http'

registerHttp()

const { provider } = ProviderRegistry.create({
  type: 'http',
  baseURL: 'https://my-gateway.example/v1',
  apiKey: process.env.GATEWAY_TOKEN ?? '',
  dialect: 'openai',
  model: 'llama-3.3-70b', // used when a call omits `model`
  headers: { 'X-Custom-Tenant': 'team-42' },
})
```

`headers` is merged **last**, over everything the driver sets, so a host keeps
the final word on every key — including `Authorization` and the `User-Agent`
described under [capabilities](#capabilities).

The Anthropic dialect talks to the native Messages API rather than a
compatibility shim:

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerHttp } from '@namzu/http'

registerHttp()

const { provider } = ProviderRegistry.create({
  type: 'http',
  baseURL: 'https://api.anthropic.com/v1',
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
  dialect: 'anthropic',
})
```

### Declaring the wrong one

Point a dialect at an endpoint that speaks the other and the **first stream
frame** raises `DialectMismatchError` — fail fast, no auto-detection.

```ts
import { DialectMismatchError } from '@namzu/http'
import type { HttpProvider } from '@namzu/http'
import type { Message } from '@namzu/sdk'

declare const provider: HttpProvider
declare const messages: Message[]

try {
  for await (const chunk of provider.chatStream({
    model: 'my-served-model',
    messages: [{ role: 'user', content: 'Hello' }],
  })) {
    if (chunk.delta.content) process.stdout.write(chunk.delta.content)
  }
} catch (err) {
  if (err instanceof DialectMismatchError) {
    console.error(err.dialect, err.url, err.status)
  }
}
```

The error carries the `dialect` you declared, the HTTP `status`, and a `url`
reduced to its **origin** — the path and query string are dropped, since either
may carry a credential. There is no body sample either: `sample` is still a
field, and its value is always the literal string `'[redacted]'`. What went
wrong is in the message; what went over the wire is not.

Silent coercion between the two shapes would corrupt tool-call arguments and
content deltas, and picking the right `dialect` is a one-line config decision, so
the failure is immediate and names the fix.

## Configuration

| Option | Default | Notes |
|---|---|---|
| `baseURL` | — | required; the constructor throws without it |
| `apiKey` | — | omitted entirely when unset, for a server that wants no auth |
| `dialect` | `'openai'` | `'openai'` or `'anthropic'` |
| `headers` | — | merged last, over every header the driver sets |
| `model` | — | fallback when a call's `model` is empty; the call always wins |
| `strictToolUse` | `'auto'` | Anthropic-dialect constrained tool input; see [capabilities](#capabilities) |
| `timeout` | `60_000` | per-request timeout in ms |

That is the whole of `HttpConfig`. `HttpProviderConfig` is the same shape plus
the `type: 'http'` discriminator the registry narrows on.

`timeout` does not replace the caller's cancellation: it is composed with
`params.signal`, so whichever fires first tears the request down and a Stop still
stops the turn mid-stream. The signal is re-checked between reads too, and it is
the caller's own abort reason that surfaces — not a `network` classification
manufactured from it.

## Capabilities

```ts
import { HTTP_CAPABILITIES } from '@namzu/http'

// {
//   supportsTools: true,
//   supportsStreaming: true,
//   supportsFunctionCalling: true,
//   supportsVision: false,
//   supportsDocuments: false,
// }
```

These describe what this **driver** does, not what your endpoint could do, and
the runtime reads them before the request is built — it warns, or fails under
`strictCapabilities`, rather than letting content vanish quietly. So the two
`false` entries are load-bearing: this driver's message translation maps role and
content, plus the tool-call fields on assistant and tool turns, and nothing else.
A user message's image or document `attachments` are not mapped and never reach
the model, on either dialect.

The other direction — a tool **result** carrying an image — cannot be dropped,
because tool messages are text-only on both wires. It degrades to a named
placeholder giving the media type and the size, rather than a JSON dump: the
model would have paid for every base64 character, read none of them, and had
nothing telling it something was withheld. Text sitting alongside the image is
kept.

Tool schemas differ by dialect, and deliberately. On the OpenAI dialect
`params.tools` is forwarded as the kernel built it. On the Anthropic dialect each
schema is converted with `toSchemaDialect(schema, '2020-12')` first, because that
wire validates tool input as JSON Schema 2020-12 and rejects the **whole**
request over one draft-07 tuple — taking every other tool in the call down with
it.

`enforceToolInputSchema` is a kernel-internal hint rather than a wire field, and
it is never serialised into the request body. On the Anthropic dialect it does
drive one thing: for each tool named in it, the driver adds `strict: true` when
`strictToolUse` says so. `'auto'`, the default, says so for model identifiers
that parse as version 4.5 or later under this dialect's own id grammar; `'on'`
opts in a proxy alias that does not spell its model that way; `'off'` disables the
mapping entirely. The model consulted is the call's, falling back to the config's.
A schema the strict subset cannot express raises through `assertStrictSchema`
before the request is sent, since the vendor would reject the whole call rather
than degrade one field. None of this applies to the OpenAI dialect.

Everything else maps by dialect. Both send `temperature`, `topP`, `topK` and
`stop` (as `stop_sequences` on the Anthropic wire). Only the OpenAI dialect sends
`frequencyPenalty`, `presencePenalty`, `repetitionPenalty`, `parallelToolCalls`
and `responseFormat`. `cacheControl` is sent on neither. A field you do not set is
not sent.

`toolChoice: 'none'` is honoured differently and both are correct for their wire:
the OpenAI dialect passes it through, and the Anthropic dialect **omits the tool
list**, because mapping it to that wire's `auto` would have said the model *may*
call a tool where the caller had forbidden it.

Every request carries one `User-Agent` from the kernel's `attributionHeaders()` —
`namzu/<version> (+https://github.com/cogitave/namzu)` — so a provider reading its
own logs can tell this kernel's traffic apart from a browser's.

Extended thinking and `effort` are not implemented here, and they are **refused**
rather than dropped. A `thinking` request of type `enabled` or `adaptive`, and
any `effort` at all, throw before the request is built; type `disabled` passes,
because asking for nothing is something this driver can honour. A silently
ignored `effort` would return an ordinary completion indistinguishable from the
model's default, including on the bill.

Token usage is read from whichever shape the endpoint used — `usage` on the
OpenAI wire, `message_start` and `message_delta` on the Anthropic one — and the
cache counts come from `prompt_tokens_details.cached_tokens` or
`cache_read_input_tokens` for reads and `cache_creation_input_tokens` for writes.
Both are `0` when the server reports neither, which is the honest answer rather
than an absent one.

## Models and health

```ts
import type { HttpProvider } from '@namzu/http'

declare const driver: HttpProvider

await driver.listModels() // []
```

Always empty, and honestly so. A generic driver cannot assume an arbitrary
endpoint exposes a catalogue, and returning a hardcoded menu of models your
server may not have loaded would be worse than returning nothing. If your
endpoint has a listing route, query it directly — you know its shape and this
package does not.

```ts
import type { HttpProvider } from '@namzu/http'

declare const driver: HttpProvider

await driver.healthCheck() // boolean
```

One `GET` against `baseURL` with a five-second timeout, reduced to a single bit,
and it never throws — an unreachable service returns `false` rather than raising.
`404` and `401` count as healthy: the point is whether something is answering at
that address, and a base URL that is not itself a route, or one that demands a
credential, has answered.

Three optional members of `LLMProvider` are **not** implemented here, and each
absence is a real consequence rather than a gap to ignore:

- no `resolveContextWindow`, so the kernel falls back to a host-configured window
  or its own hand-kept prefix table — set the window explicitly if your served
  model's is unusual;
- no `probeCredential`, so a credential pointed at this driver is reported as
  unverifiable rather than verified. `healthCheck()` is not a substitute: it
  treats `401` as alive;
- no `reasoningEffortLevelsFor` (nor its deprecated `effortLevelsFor`
  compatibility spelling), consistent with `effort` being refused above.

## Errors

Every failure this driver raises is a `ProviderRequestError` from `@namzu/sdk`,
classified into the kernel's own kinds — `throttle`, `network`, `auth`,
`context_overflow`, `bad_request`, `server` — so a caller can decide whether to
retry, compact or give up without parsing a vendor payload.

| What happened | `kind` |
|---|---|
| `401` / `403` | `auth` |
| `429` | `throttle`, with `retryAfterMs` parsed from the `retry-after` header |
| `408` / `425` | `network` |
| `5xx` | `server` |
| a `4xx` whose body says the prompt is too long | `context_overflow` |
| any other `4xx` | `bad_request` |
| `fetch` itself rejected | `network`, unless the rejection names its own kind |

```ts
import { isProviderRequestError } from '@namzu/sdk'

import type { HttpProvider } from '@namzu/http'
import type { Message } from '@namzu/sdk'

declare const provider: HttpProvider
declare const messages: Message[]

try {
  for await (const chunk of provider.chatStream({
    model: 'my-served-model',
    messages: [{ role: 'user', content: 'Hello' }],
  })) {
    if (chunk.delta.content) process.stdout.write(chunk.delta.content)
  }
} catch (err) {
  if (isProviderRequestError(err) && err.kind === 'throttle') {
    await new Promise((r) => setTimeout(r, err.retryAfterMs ?? 1000))
  }
}
```

The error body is read to classify and is never interpolated into the thrown
message. That is not hygiene, it is a fix: the body used to be pasted into the
message together with the URL, which is how a credential an upstream echoed back
— or one embedded in the URL — reached every log that recorded the failure,
proven with a planted fake token.

Failures reported **after** a `200` are read and raised too, because ignoring
them makes a failed stream look like a clean end of turn: an `error` field inside
an OpenAI frame, and the Anthropic wire's `error` event, both go through the same
classifier. A frame that will not parse raises as `server` without keeping the
frame, since a JSON parse error quotes the source text it choked on.

`DialectMismatchError` is the one failure that is not a `ProviderRequestError` —
it is a configuration mistake rather than a provider one, and it is described
under [declaring the wrong one](#declaring-the-wrong-one).
