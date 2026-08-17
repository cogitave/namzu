---
uid: namzu.providers.openai
title: The OpenAI driver — configuration, refusals and compatible endpoints
description: Reference for @namzu/openai: every configuration field, what the driver refuses rather than approximating, the health and model-listing surfaces, and what changes when you point it at an OpenAI-compatible endpoint.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-17T00:00:00Z
lastReviewed: 2026-08-17
resource: packages/providers/openai/src/index.ts
tags: [provider, openai, reference]
---

# The OpenAI driver — configuration, refusals and compatible endpoints


`@namzu/sdk` has no preferred model vendor. It defines the `LLMProvider`
contract and ships a scriptable mock; every real service is a separate driver
package, installed only if you call that service.

This is the driver for OpenAI. It wraps the official
[`openai`](https://www.npmjs.com/package/openai) client and speaks the **Chat
Completions API**: one streaming entry point, tool use with optional
constrained generation, image and document attachments, and the kernel's error
taxonomy on every failure path.

Nothing here is a second way to talk to the model. The driver's job is to turn
the kernel's request into this vendor's request and its response back into
`StreamChunk`s — and to refuse, loudly, anything the kernel can ask for that
this wire cannot carry.


## Use it

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOpenAI } from '@namzu/openai'

import type { Message } from '@namzu/sdk'

declare const messages: Message[]

// Once, at startup.
registerOpenAI()

const { provider } = ProviderRegistry.create({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini', // default; overridable per call
})

for await (const chunk of provider.chatStream({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

`registerOpenAI()` adds the `'openai'` type to the kernel's registry and
augments `ProviderConfigRegistry`, so a `create()` call carrying
`type: 'openai'` is fully type-narrowed to this driver's config. Registering a
second time throws `DuplicateProviderError`; pass `{ replace: true }` if that
is what you meant.

**There is one model entry point and it streams.** `LLMProvider` declares
`chatStream(params)` and nothing else — there is no `chat()` method on this or
any other driver. When you want the aggregated, non-streaming shape, drain the
stream through the kernel's helper:

```ts
import { collectChatCompletion } from '@namzu/sdk'

import type { OpenAIProvider } from '@namzu/openai'
import type { Message } from '@namzu/sdk'

declare const provider: OpenAIProvider
declare const messages: Message[]

const response = await collectChatCompletion(
  provider.chatStream({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hello' }],
  }),
)

console.log(response.message.content)
```

Most callers never do either, because the run loop consumes the stream itself:

```ts
import { runAgent } from '@namzu/sdk'

import type { OpenAIProvider } from '@namzu/openai'

declare const provider: OpenAIProvider

const { output, run } = await runAgent({
  provider,
  model: 'gpt-4o-mini',
  prompt: 'What is the capital of France?',
})
```

You can also construct the driver directly and skip the registry — useful when
a host holds one provider per tenant rather than one per process:

```ts
import { OpenAIProvider } from '@namzu/openai'

const provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! })
```

## Configuration

| Field | Default | Notes |
|---|---|---|
| `apiKey` | — | required; the constructor throws on an empty value |
| `model` | — | default model, overridden by `params.model` on a call |
| `baseURL` | `OPENAI_BASE_URL`, else `https://api.openai.com/v1` | any OpenAI-shaped endpoint |
| `organization` | — | organization id |
| `project` | — | project id |
| `timeout` | the `openai` client's default (10 minutes) | per-request, in milliseconds |
| `defaultHeaders` | — | merged **over** the attribution header on every request |

```ts
import type { OpenAIConfig, OpenAIProviderConfig } from '@namzu/openai'
// OpenAIProviderConfig is OpenAIConfig plus the `type: 'openai'` discriminator
// the registry narrows on. The class takes the former; `create()` takes the latter.
```

That table is the whole surface. A field the vendor client accepts and this
config does not name — `maxRetries`, for one — is not forwarded, and the
client's own default stands.

`apiKey` is checked here rather than left to the vendor client, so setting
`OPENAI_API_KEY` in the environment is not by itself enough: read it and pass
it. The driver sends one `User-Agent` header identifying the kernel and its
version, merged so that anything you put in `defaultHeaders` wins — including
that header, if you would rather send your own.

## Capabilities

```ts
import { OPENAI_CAPABILITIES } from '@namzu/openai'

// {
//   supportsTools: true,
//   supportsStreaming: true,
//   supportsFunctionCalling: true,
//   supportsVision: true,
//   supportsDocuments: true,
// }
```

A capability declaration here is about **this driver**, not about the vendor
API: it answers "does the code map this?" rather than "could it?". The runtime
negotiates against the constructed instance, and an absent flag is read as
permissive — so a missing flag is a claim, not an omission, which is why all
five are stated.

What each one is claiming:

- **Tools.** `params.tools` become function tools. `params.toolChoice` maps to
  `auto` / `none` / `required` or a named function, and `parallelToolCalls` is
  passed through.
- **Constrained tool input.** Every tool named in `enforceToolInputSchema` is
  sent with `strict: true` on the function, so its schema is enforced rather
  than suggested. Tools not named are unaffected.
- **Vision.** An image attachment on a user message becomes an `image_url`
  content part carrying a base64 data URI, with the message text first.
- **Documents.** A document attachment becomes a `file` part — not an image
  part with a different media type, which is what it used to be.

Two more shapes are worth knowing because they are not flags. Tool result
messages are text-only on this wire, so a structured result degrades through
the kernel's `toolResultToText` to an honest placeholder rather than having a
base64 payload dumped into the transcript. And the stream is requested with
usage included, so `chunk.usage` carries real token counts — `cachedTokens`
comes from the vendor's prompt-token detail, and `cacheWriteTokens` is always
`0` because this API does not report cache writes.

This driver emits no per-tool `toolCallEnd` boundary; the orchestrator infers
tool completion from the end of the stream. It emits no reasoning deltas and no
citation deltas either — which is not a gap to work around but the reason two
requests are refused outright, below.

## What it refuses

The kernel's rule is that a capability accepted and then quietly not applied is
worse than one that errors, because the caller stops looking. Four requests
throw here instead of being dropped:

- **`thinking: { type: 'enabled' | 'adaptive' }`** — this driver does not
  implement extended thinking. Dropping the field would return an ordinary
  completion with an empty reasoning list, which reads as "the model did not
  reason" rather than "nobody asked it to". `{ type: 'disabled' }` and an
  absent field are accepted, because off is the state the driver is already in.
- **`effort`** — refused on the same reasoning, and it is the quieter failure
  of the two: a run someone believes they paid for at `max` would be
  indistinguishable from one at the model's default, including on the bill.
- **A document attachment with `citations: true`** — this request format has no
  way to carry citations back, and answering without them removes exactly the
  checkability that was asked for.
- **A `stored` attachment that reaches the driver unresolved** — resolve it
  against the run's attachment store first. Skipping it would send a user
  message that silently lost its image.

The error names the driver and says what to do instead, which is what turns a
bug report about the model into a one-line configuration change in a
multi-provider setup.

## Errors

Every failure leaves this driver as the kernel's `ProviderRequestError`,
classified into the shared taxonomy — `auth`, `throttle`, `bad_request`,
`context_overflow`, `server`, `network` — with the status, a `Retry-After`
translated to milliseconds where the vendor sent one, and a scrubbed `detail`.

```ts
import { isProviderRequestError } from '@namzu/sdk'

import type { OpenAIProvider } from '@namzu/openai'
import type { Message } from '@namzu/sdk'

declare const provider: OpenAIProvider
declare const messages: Message[]

try {
  for await (const chunk of provider.chatStream({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hello' }],
  })) {
    if (chunk.delta.content) process.stdout.write(chunk.delta.content)
  }
} catch (err) {
  if (isProviderRequestError(err) && err.kind === 'throttle') {
    // err.retryAfterMs, err.status, err.detail
  }
}
```

The vendor error is **dropped**, not re-thrown and not attached as `cause`. The
`openai` client builds its message from the response body, so a credential the
upstream echoed back is already inside that message before this code runs — and
a `cause` is precisely what a structured logger walks. Classification is taken
from the status instead.

`params.signal` is honoured end to end: it is handed to the vendor request so
an abort tears down the in-flight SSE connection, and it is re-checked between
chunks so a stop lands mid-turn rather than at the next turn boundary. On abort
the signal's own `reason` is what you catch.

The driver declares no retry defaults, so the kernel's generic retry policy
applies, and the vendor client's internal retry behaviour is left exactly as it
ships.

## Health and model listing

- `probeCredential()` makes an authenticated call and rejects if the key is
  refused. It is declared rather than inferred: a driver that does not
  implement one is reported as *not checked*, never as verified.
- `listModels()` returns the live catalogue as `ModelInfo[]`. Treat it as a
  menu, not a rate card — `inputPrice` and `outputPrice` come back `0` because
  the listing endpoint does not carry prices.
- `healthCheck()` is the same probe reduced to a boolean.

All three are optional members of `LLMProvider`, so call them through the
optional chain (`await provider.probeCredential?.()`) unless you are holding
the concrete class. `doctorCheck`, `effortLevelsFor` and `resolveContextWindow` are
not implemented here, and are absent rather than stubbed — the runtime tells
"this driver cannot answer" from "it answered nothing", and a stub would
destroy that distinction.

## OpenAI-compatible endpoints

Setting `baseURL` points this driver at anything speaking the same shape:
Azure OpenAI with a deployment URL, an enterprise endpoint, a self-hosted
gateway, or a local server. The package constructs the base `OpenAI` client
only — it does not expose the vendor's Azure-specific constructor, so an Azure
deployment that needs that client's URL and api-version handling is better
built with the vendor SDK directly.

For a generic compatible backend where you would rather not carry the vendor
client at all, [`@namzu/http`](https://www.npmjs.com/package/@namzu/http) with
`dialect: 'openai'` is the zero-dependency alternative.

## Observability

There is nothing to install or enable here. The kernel emits the GenAI
semantic-convention spans and metrics around the model call itself — request
model, token usage, finish reason — so they are the same whichever driver is
underneath. Add [`@namzu/telemetry`](https://www.npmjs.com/package/@namzu/telemetry)
to export them; without an exporter installed, the OTel API's no-op defaults
discard them.
