---
title: The LM Studio driver — the local server, configuration and cost
description: Reference for @namzu/lmstudio: what the local server has to be running, every configuration field, why a locally served model reports zero cost, and the error surface when the server is absent.
type: Reference
status: stable
resource: packages/providers/lmstudio/src/index.ts
tags: [provider, lmstudio, reference]
generated: { by: human:bahadirarda, at: 2026-08-17T00:00:00Z }
---

# The LM Studio driver — the local server, configuration and cost


One driver, one wire. `LMStudioProvider` implements the kernel's `LLMProvider`
contract on top of the official [`@lmstudio/sdk`](https://www.npmjs.com/package/@lmstudio/sdk),
which reaches the local LM Studio server over a websocket rather than over its
HTTP endpoint. There is no non-streaming path, because the contract has no
non-streaming method — `chatStream` is the single model entry point, and a
caller who wants the whole answer collects the stream.

It is a separate package so a consumer who never runs a model on their own
machine does not carry the vendor client to use none of it. `@namzu/sdk` is a
peer dependency (`>=1.3.0`), so your lockfile owns the kernel version rather
than this package.

If you would rather not add a vendor client at all,
[`@namzu/http`](https://www.npmjs.com/package/@namzu/http) reaches the same
server over its compatibility endpoint with zero runtime dependencies:

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerHttp } from '@namzu/http'

registerHttp()

const { provider } = ProviderRegistry.create({
  type: 'http',
  baseURL: 'http://localhost:1234/v1',
  dialect: 'openai',
})
```

This package exists for the other direction: it speaks the vendor client's own
websocket protocol rather than the compatibility endpoint, and pays one
dependency for it.


## The server

This driver drives a server it does not start. LM Studio has to be running and
the model has to be **loaded**, not merely downloaded — start the local server
from the application's Developer tab, or from its command line:

```bash
lms server start
lms load <model>
```

Resolving the model is the slow step, and it is the reason the deadline below
covers more than generation. The websocket connects at once while the model is
still being read into memory, and not a single token is produced until it is.

## Use it

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerLMStudio } from '@namzu/lmstudio'

import type { Message } from '@namzu/sdk'

declare const messages: Message[]

registerLMStudio() // once, at startup

const { provider } = ProviderRegistry.create({
  type: 'lmstudio',
  model: 'qwen3-8b',
})

for await (const chunk of provider.chatStream({
  model: 'qwen3-8b',
  messages: [{ role: 'user', content: 'Hello' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

`registerLMStudio()` also carries the module augmentation that adds
`'lmstudio'` to the kernel's config union, so `ProviderRegistry.create({ type:
'lmstudio', … })` narrows to `LMStudioProviderConfig` and a typo in the config
is a compile error. Call it twice and it throws `DuplicateProviderError`; pass
`{ replace: true }` when you mean to take the slot over.

When you want the aggregated response rather than the deltas, collect the same
stream:

```ts
import { collectChatCompletion } from '@namzu/sdk'

import type { LMStudioProvider } from '@namzu/lmstudio'
import type { Message } from '@namzu/sdk'

declare const provider: LMStudioProvider
declare const messages: Message[]

const response = await collectChatCompletion(
  provider.chatStream({
    model: 'qwen3-8b',
    messages: [{ role: 'user', content: 'Hello' }],
  }),
)

console.log(response.message.content)
console.log(response.usage.totalTokens)
```

Constructing the provider opens nothing. The websocket is built on first use,
because the registry constructs every configured provider whether or not
anything asks it for a completion — and dialling a local server that is usually
not running turned an unused config entry into a connection failure nobody
owned.

This driver is constructed by your own code, not by the terminal agent:
`@namzu/cli` does not depend on this package, and its provider table records
`lmstudio` as one that build cannot construct.

## Configuration

| Option | Default | Notes |
|---|---|---|
| `host` | `LMSTUDIO_HOST`, else the vendor client's own local discovery | `http(s)://` is accepted and rewritten to `ws(s)://` |
| `model` | — | the default model; `params.model` overrides it per call |
| `timeout` | none | deadline in ms, composed with the caller's signal |

That is the whole of `LMStudioConfig`. There is deliberately no transport seam:
the vendor client owns the websocket, which is also why the tests here
substitute that client rather than an HTTP layer.

`host` is normalised rather than validated. The vendor client requires a
websocket URL, so `http://localhost:1234` is accepted and rewritten for you.
With neither `host` nor `LMSTUDIO_HOST` set, nothing is passed and the vendor
client discovers the local server itself.

`model` may come from the config, from the call, or from both — the call wins.
With neither, the request fails naming both places it could have come from,
rather than reaching the server without one.

`timeout` covers resolving the model as well as generating with it, which is
the wait it exists for. It is composed with `params.signal` rather than
replacing it: dropping the caller's cancellation for a deadline would leave a
local model generating after the run that asked for it has stopped. Leave it
out and there is no deadline at all. Zero or negative is refused rather than
applied, because such a deadline would abort every request before it was sent.

## Capabilities

```ts
import { LMSTUDIO_CAPABILITIES } from '@namzu/lmstudio'

// {
//   supportsTools: false,
//   supportsStreaming: true,
//   supportsFunctionCalling: false,
//   supportsVision: false,
//   supportsDocuments: false,
// }
```

These describe what this **driver** does, not what LM Studio could do, and the
runtime reads them before the request is built. So the four `false` entries are
load-bearing rather than pessimistic.

**Tools are not sent.** `chatStream` never reads `params.tools`, so no schema
reaches the model. Register tools against this driver and the runtime strips
every tool surface from the prompt and the request — with a warning that says
so, or an outright failure under `strictCapabilities: true` — which is better
than telling a model about tools it will never be able to call. A tool message
already in the history is folded onto a `user` turn behind a `[tool-result]`
marker, so it reads as a result rather than as a person speaking. Its content
goes through the kernel's `toolResultToText`, so a result carrying an image
arrives as a named placeholder rather than a wall of base64 the model spends
context on and cannot read.

**Message mapping is text only**, onto the three roles this chat API has:
`system` and `assistant` stay themselves, and everything else folds onto
`user`. Image `attachments` on a user message are not mapped and never reach
the model, which is exactly what `supportsVision: false` tells the negotiation
before the request is built.

**Thinking and `effort` are refused, not dropped.** Setting either throws
before anything is sent, naming this driver. Ignoring them would return an
ordinary completion — indistinguishable from a model that simply chose not to
reason, and from a run someone believed they had requested at a higher effort.
`thinking: { type: 'disabled' }` stays a no-op, because that is the state a
driver without thinking is already in, and a config shared across providers
should not fail on the ones that were never going to think.

## Models and cost

```ts
import type { LMStudioProvider } from '@namzu/lmstudio'

declare const provider: LMStudioProvider

await provider.listModels()   // the models LM Studio currently has loaded
await provider.healthCheck()  // the same call, reduced to one bit
```

Both answer from the vendor client's loaded-model list, and both degrade
quietly on purpose: an unreachable server yields an empty array and `false`
rather than a throw, because these are the calls a picker and a health screen
make before anyone has decided anything.

The prices on those entries are zero, and zero is the true number here rather
than a placeholder. The kernel's price catalogue records `lmstudio` as an
unmetered vendor, so `resolveModelPricing('lmstudio', …)` resolves to a rate of
zero for any model id — distinct from `undefined`, which would mean the total
is unknowable. One consequence is worth stating plainly: a `costLimitUsd` is
measurable against this driver and will therefore never fire, since the
accumulated cost of a local run is always zero. Bound a run here with
`tokenBudget` or `maxIterations` instead.

## Errors

Every failure this driver raises is a `ProviderRequestError` from `@namzu/sdk`,
classified into the kernel's own kinds — `network`, `throttle`, `auth`,
`bad_request`, `context_overflow`, `server` — so a caller can decide whether to
retry, compact or give up without importing the vendor client. The vendor's own
sentence is kept, because "websocket failed" is the half an operator needs, and
credential-shaped substrings inside it are replaced by a `[REDACTED:…]` marker.
The original error is never attached as `cause`: that is the channel a logger
would serialize a raw body through no matter what the message says.

**A context overflow is a failure, not a finish reason.** The vendor reports
`contextLengthReached` for two different events. After content, it is a genuine
truncation and stays `finishReason: 'length'` — the runtime's auto-continuation
depends on that. With no content at all, the *prompt* did not fit and the turn
failed; folding that into `'length'` presented an empty string as a successful
turn, so it is raised as `kind: 'context_overflow'` instead.

`params.signal` is handed to the vendor prediction, so a stop sends the real
server-side cancel and the local model stops generating — leaving the
`for await` loop alone does not. The same signal also races model resolution,
which the vendor client accepts no signal for; without that race, a stop
pressed while the model was still loading would not return until the vendor
did. Either way the caller's own abort reason is what surfaces, unchanged.
