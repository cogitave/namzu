<!-- okf
type: Reference
title: "@namzu/openrouter"
description: >-
  The OpenRouter driver for @namzu/sdk. Speaks OpenRouter's OpenAI-compatible
  Chat Completions wire over native fetch with no runtime dependencies, maps
  tool use, and answers the kernel's context-window question from the vendor's
  own catalogue rather than from a hand-kept table.
tags: [readme, package, provider, openrouter]
timestamp: 2026-08-17T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/openrouter</h1>

**The OpenRouter driver for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk).**

[![License: FSL-1.1-MIT](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)
[![npm](https://img.shields.io/npm/v/@namzu/openrouter.svg?label=%40namzu%2Fopenrouter)](https://www.npmjs.com/package/@namzu/openrouter)

[Install](#install) · [Use it](#use-it) · [Models](#models-and-the-window) · [Credentials](#credentials-and-attribution) · [Config](#configuration) · [Capabilities](#capabilities) · [Health](#health) · [Errors](#errors)

</div>

---

## What this is

One driver, one wire. `OpenRouterProvider` implements the kernel's
`LLMProvider` contract against OpenRouter's OpenAI-compatible Chat Completions
endpoint, and it sends exactly one request: `POST /chat/completions` with
`stream: true`. There is no non-streaming path, because the contract has no
non-streaming method — `chatStream` is the single model entry point, and a
caller who wants the whole answer collects the stream.

The transport is native `fetch` and nothing else. This package declares no
runtime dependencies at all: no vendor SDK, no HTTP client, no JSON tooling.
`@namzu/sdk` is a peer dependency (`>=1.3.0`), so your lockfile owns the kernel
version rather than this package.

What it buys over a driver bound to one vendor is the aggregation: OpenRouter
fronts hundreds of models from a dozen vendors behind one key and one bill, and
switching between them is a change to the `model` string rather than to which
package is installed. That also makes it the driver where a static model table
goes stale fastest, which is why nothing about the catalogue is hardcoded here
— see [Models and the window](#models-and-the-window).

## Install

```bash
pnpm add @namzu/sdk @namzu/openrouter
```

## Use it

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOpenRouter } from '@namzu/openrouter'

registerOpenRouter() // once, at startup

const { provider } = ProviderRegistry.create({
  type: 'openrouter',
  apiKey: process.env.OPENROUTER_API_KEY ?? '',
  siteUrl: 'https://example.com', // optional
  siteName: 'Example',            // optional
})

for await (const chunk of provider.chatStream({
  model: 'anthropic/claude-opus-5',
  messages: [{ role: 'user', content: 'Hello' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

`registerOpenRouter()` also carries the module augmentation that adds
`'openrouter'` to the kernel's config union, so `ProviderRegistry.create({ type:
'openrouter', … })` narrows to `OpenRouterProviderConfig` and a typo in the
config is a compile error. Call it twice and it throws `DuplicateProviderError`;
pass `{ replace: true }` when you mean to take the slot over.

`create()` hands back the driver's capability declaration alongside it, which is
the same object as [`OPENROUTER_CAPABILITIES`](#capabilities):

```ts
const { provider, capabilities } = ProviderRegistry.create({
  type: 'openrouter',
  apiKey: process.env.OPENROUTER_API_KEY ?? '',
})
```

When you want the aggregated response rather than the deltas, collect the same
stream:

```ts
import { collectChatCompletion } from '@namzu/sdk'

const response = await collectChatCompletion(
  provider.chatStream({
    model: 'anthropic/claude-opus-5',
    messages: [{ role: 'user', content: 'Hello' }],
  }),
)

console.log(response.message.content)
console.log(response.usage.totalTokens)
```

The terminal agent constructs this driver for you: `@namzu/cli` lists
`openrouter` among the provider types it can build, reads `OPENROUTER_API_KEY`
from the environment, and defaults to `https://openrouter.ai/api/v1` and the
model `anthropic/claude-opus-5`.

`listModels`, `resolveContextWindow`, `probeCredential` and `healthCheck` are
**optional** members of `LLMProvider`, so a caller holding the interface has to
guard them. The snippets below hold the class instead, where they are ordinary
methods:

```ts
import { OpenRouterProvider } from '@namzu/openrouter'

const driver = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY ?? '',
})
```

## Models and the window

Model ids follow OpenRouter's `vendor/model-name` pattern —
`anthropic/claude-opus-5` — and the authority on which ones exist today is the
vendor, not this package. There is no hardcoded catalogue here to go stale.

```ts
await driver.listModels()
// id, name, contextWindow, maxOutputTokens, inputPrice, outputPrice,
// supportsToolUse, supportsStreaming
```

`listModels()` returns exactly what `GET /models` sent, with no fallback list
behind it: `contextWindow` is the catalogue's `context_length`,
`maxOutputTokens` is `top_provider.max_completion_tokens` where the vendor
states one and `4096` where it does not, and `inputPrice` / `outputPrice` are
the catalogue's per-token prices scaled to per-million. If the listing call
fails, it throws rather than substituting a menu.

`resolveContextWindow(model)` answers the kernel's own question — how large is
this model's context — from that same listing. It matters because the fallback
below it is a hand-maintained prefix table, and this is the driver a hand-kept
table is least able to keep up with. The kernel's precedence is: a window you
configured, then the driver's answer, then the table, then the default.

```ts
await driver.resolveContextWindow('anthropic/claude-opus-5')
// the vendor's own context_length, or undefined
```

`undefined` for a model the listing does not contain, deliberately, rather than
a guess: "I asked and it is not there" leaves the table exactly as authoritative
as it was, while a substituted number would present a guess as a vendor answer.
The listing is resolved once per process, because several hundred models is a
real payload and a window does not change under a running run. A **failure** is
not cached — the next run asks again rather than inheriting one bad minute
forever.

## Credentials and attribution

`apiKey` is required and the constructor throws when it is empty. This driver
does not read the key from the environment itself — pass it, from wherever your
host keeps secrets. (`@namzu/cli` is the thing in this repository that reads
`OPENROUTER_API_KEY`; the library leaves that choice to you.)

`siteUrl` and `siteName` are optional and are sent verbatim as the
`HTTP-Referer` and `X-Title` headers, which is how OpenRouter attributes traffic
to an application. Omit them and the headers are not sent at all.

Every request also carries one `User-Agent` from the kernel's
`attributionHeaders()` — `namzu/<version> (+https://github.com/cogitave/namzu)`
— so a provider reading its own logs can tell this kernel's traffic apart from a
browser's. It is one header and only one, by design.

`probeCredential()` asks whether the key works, and it asks the endpoint that
can answer:

```ts
await driver.probeCredential() // resolves if the key is accepted, throws if not
```

It calls `GET /key`, which requires the credential. The obvious alternative was
measured and does not work: `/models` does not authenticate, so **any** string
whatsoever — a typo, the wrong clipboard entry, a revoked key — came back with
the full catalogue and was reported as verified. Nothing was wrong with the
menu; a menu was simply never evidence about a key. The thrown error carries the
HTTP `status`, so a caller can separate a genuine `401` from a timeout that
taught it nothing.

## Configuration

| Option | Default | Notes |
|---|---|---|
| `apiKey` | — | required; the constructor throws on an empty string |
| `baseUrl` | `OPENROUTER_BASE_URL`, else `https://openrouter.ai/api/v1` | any OpenAI-compatible endpoint |
| `siteUrl` | — | sent as `HTTP-Referer` |
| `siteName` | — | sent as `X-Title` |
| `timeout` | `120_000` | per-request timeout in ms |

That is the whole of `OpenRouterConfig`. `OpenRouterProviderConfig` is the same
shape plus the `type: 'openrouter'` discriminator the registry narrows on.

Two details about the defaults are worth knowing before you debug them. The
`OPENROUTER_BASE_URL` fallback is read **once, at module load**, into a module
constant — setting it after this package has been imported changes nothing, so
set it before the process starts or pass `baseUrl` explicitly. And `timeout`
does not replace the caller's cancellation: it is composed with
`params.signal`, so whichever fires first tears the request down and a Stop
still stops the turn mid-stream.

Because the wire is the OpenAI Chat Completions dialect, pointing `baseUrl` at
another server that speaks it works. If that is the whole reason you are here —
a self-hosted inference server rather than OpenRouter — `@namzu/http` is the
driver built for it and ships today.

## Capabilities

```ts
import { OPENROUTER_CAPABILITIES } from '@namzu/openrouter'

// {
//   supportsTools: true,
//   supportsStreaming: true,
//   supportsFunctionCalling: true,
//   supportsVision: false,
//   supportsDocuments: false,
// }
```

These describe what this **driver** does, not what OpenRouter could do, and the
runtime reads them before the request is built — it warns, or fails under
`strictCapabilities`, rather than letting content vanish quietly. So the two
`false` entries are load-bearing: this driver's message translation maps role
and content, plus the tool-call fields on assistant and tool turns, and nothing
else. A user message's image or document `attachments` are not mapped and never
reach the model.

Tool schemas pass through as the kernel built them, along with `toolChoice` and
`parallelToolCalls`. `enforceToolInputSchema` is a kernel-internal hint rather
than a wire field, and it is deliberately dropped instead of being serialised
into the request body.

The rest of `ChatCompletionParams` maps straight onto the OpenAI-dialect names:
`temperature`, `maxTokens` → `max_tokens`, `topP`, `topK`, `frequencyPenalty`,
`presencePenalty`, `repetitionPenalty`, `stop`, `responseFormat` →
`response_format`, and `cacheControl` → `cache_control`. A field you do not set
is not sent.

Token usage comes back on the chunk that carries it, and the cache counts are
read from whichever shape the upstream model used: `cachedTokens` from
`prompt_tokens_details.cached_tokens` or `cache_read_input_tokens`, and
`cacheWriteTokens` from `cache_creation_input_tokens`. Both are `0` when the
vendor reports neither, which is the honest answer rather than an absent one.

Extended thinking and `effort` are not implemented here, and they are
**refused** rather than dropped — setting `thinking: { type: 'enabled' }`,
`thinking: { type: 'adaptive' }` or any `effort` throws before the request is
built. `thinking: { type: 'disabled' }` passes, because asking for nothing is
something this driver can honour. A silently ignored `effort` would return an
ordinary completion indistinguishable from the model's default, including on the
bill.

## Health

```ts
await driver.healthCheck() // boolean
```

One `GET /models` with a five-second timeout, reduced to a single bit, and it
never throws — an unreachable service returns `false` rather than raising. Read
it as "is this endpoint answering", not as "is my key good": that endpoint does
not authenticate. [`probeCredential()`](#credentials-and-attribution) is the one
that answers the credential question.

## Errors

Every failure this driver raises is a `ProviderRequestError` from `@namzu/sdk`,
classified into the kernel's own kinds — `throttle`, `network`, `auth`,
`context_overflow`, `bad_request`, `server` — so a caller can decide whether to
retry, compact or give up without parsing a vendor payload.

| What happened | `kind` |
|---|---|
| `401` / `403` | `auth` |
| `429` | `throttle`, with `retryAfterMs` parsed from the `retry-after` header |
| `5xx` | `server` |
| `4xx` whose body says the prompt is too long | `context_overflow` |
| any other `4xx` | `bad_request` |
| `fetch` itself rejected | `network`, unless the rejection names its own kind |

The error body is read to classify and is never interpolated into the thrown
message. That is not hygiene, it is a fix: the body used to be pasted into the
message verbatim, which is how a credential the upstream echoed back reached
every log that recorded the failure — proven with a planted fake token. What
survives is the vendor's own `error.message`, truncated and with
credential-shaped substrings replaced by a `[REDACTED:…]` marker, on the error's
`detail` field. The vendor error is not attached as `cause` either.

OpenRouter also reports some failures **after** a `200`, as an `error` field
inside a stream frame. Those are read and raised too, because ignoring them
makes a failed stream look like a clean end of turn. A frame that will not parse
raises as `server` without keeping the frame, since a JSON parse error quotes
the source text it choked on.

`params.signal` is composed with the request timeout and re-checked between
reads, so a Stop tears the in-flight response body down mid-turn, and it is the
caller's own abort reason that surfaces — not a `network` classification
manufactured from it.

## License

FSL-1.1-MIT, converting to MIT two years after each release. Same as
`@namzu/sdk`.
