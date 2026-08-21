---
uid: namzu.providers.ollama
title: The Ollama driver — configuration, refusals and cancellation
description: Reference for @namzu/ollama: every configuration field, what the driver refuses rather than silently approximating, how cancellation reaches a running generation, and how to use it without carrying the vendor client.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-21T00:00:00Z
lastReviewed: 2026-08-21
resource: packages/providers/ollama/src/index.ts
tags: [provider, ollama, reference]
---

# The Ollama driver — configuration, refusals and cancellation


`@namzu/sdk` has no preferred model vendor. It defines the `LLMProvider`
contract and ships a scriptable mock; every real service is a separate driver
package, installed only if you call that service.

This is the driver for [Ollama](https://ollama.com) — a daemon you run on your
own hardware, so the request never leaves the machine and there is no
credential to hold. It wraps the official
[`ollama`](https://www.npmjs.com/package/ollama) client and speaks the chat
endpoint: streamed text, the sampling parameters the wire accepts, a request
deadline, and the kernel's error taxonomy on every failure path.

It is the narrowest driver in the set, and deliberately so. **Text in, text
out.** No tool schemas reach the model, and image and document attachments are
not mapped. Those are statements about *this driver*, not about what your
model could do — see [Capabilities](#capabilities), which is where the
consequence of each is written down rather than implied.


## Use it

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOllama } from '@namzu/ollama'

import type { Message } from '@namzu/sdk'

declare const messages: Message[]

// Once, at startup.
registerOllama()

const { provider } = ProviderRegistry.create({
  type: 'ollama',
  model: 'llama3.2', // default; overridable per call
})

for await (const chunk of provider.chatStream({
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'Hello' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

`registerOllama()` adds the `'ollama'` type to the kernel's registry and
augments `ProviderConfigRegistry`, so `ProviderRegistry.create({ type:
'ollama', … })` is fully type-narrowed to this driver's config. Registering a
second time throws `DuplicateProviderError`; pass `{ replace: true }` if that
is what you meant. `create()` also hands back the registered capability
declaration, if you want to read it at the call site:

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOllama } from '@namzu/ollama'

registerOllama()

const { provider, capabilities } = ProviderRegistry.create({ type: 'ollama' })
```

**There is one model entry point and it streams.** `LLMProvider` declares
`chatStream(params)` and nothing else — there is no `chat()` method on this or
any other driver. When you want the aggregated, non-streaming shape, drain the
stream through the kernel's helper:

```ts
import { collectChatCompletion } from '@namzu/sdk'

import type { OllamaProvider } from '@namzu/ollama'
import type { Message } from '@namzu/sdk'

declare const provider: OllamaProvider
declare const messages: Message[]

const response = await collectChatCompletion(
  provider.chatStream({
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'Hello' }],
  }),
)

console.log(response.message.content)
```

Most callers never do either, because the run loop consumes the stream itself:

```ts
import { runAgent } from '@namzu/sdk'

import type { OllamaProvider } from '@namzu/ollama'

declare const provider: OllamaProvider

const { output, run } = await runAgent({
  provider,
  model: 'llama3.2',
  prompt: 'What is the capital of France?',
})
```

You can also construct the driver directly and skip the registry — useful when
a host holds one provider per backend rather than one per process:

```ts
import { OllamaProvider } from '@namzu/ollama'

const provider = new OllamaProvider({ host: 'http://gpu-box.lan:11434' })
```

## Configuration

| Field | Default | Notes |
|---|---|---|
| `host` | `OLLAMA_HOST`, else `http://localhost:11434` | base URL of the daemon |
| `model` | — | default model, overridden by `params.model` on a call |
| `fetch` | global `fetch` | transport override, e.g. to add a header for a reverse proxy |
| `timeout` | none | per-request deadline in milliseconds |

```ts
import type { OllamaConfig, OllamaProviderConfig } from '@namzu/ollama'
// OllamaProviderConfig is OllamaConfig plus the `type: 'ollama'` discriminator
// the registry narrows on. The class takes the former; `create()` takes the latter.
```

That table is the whole surface, and every field is optional: `new
OllamaProvider()` is a valid local setup. A model has to come from somewhere,
though — `params.model` or `config.model` — and a call with neither throws
before any request is made.

**`timeout` covers the whole request, not the time to the first byte.** The
failure it exists for is the one a local server actually produces: the process
is up, the socket accepts, and the answer never comes because the model is
still loading or the machine is out of memory. Bounding only the head leaves
exactly that case unbounded. A host that wants long generations sets a long
deadline or leaves it absent, which is no deadline at all. It composes with
`params.signal` rather than replacing it, so a run that is stopped still tears
down the connection. A zero, negative or non-finite value throws at
construction instead of aborting every request before it is sent.

Of the sampling parameters on `ChatCompletionParams`, five are forwarded —
`temperature`, `topP`, `topK`, `maxTokens` (as `num_predict`) and `stop`. The
rest, including `frequencyPenalty`, `presencePenalty`, `repetitionPenalty` and
`responseFormat`, are not sent. Setting one changes nothing here.

## Capabilities

```ts
import { OLLAMA_CAPABILITIES } from '@namzu/ollama'

// {
//   supportsTools: false,
//   supportsStreaming: true,
//   supportsFunctionCalling: false,
//   supportsVision: false,
//   supportsDocuments: false,
// }
```

A capability declaration here is about **this driver**, not about the vendor
API: it answers "does the code map this?" rather than "could it?". The runtime
negotiates against the constructed instance, and an absent flag is filled in
permissively, field by field — so a missing flag is a claim, not an omission,
which is why all five are stated.

- **No tools, and no way to opt in.** `chatStream` never reads `params.tools`,
  so no tool schema reaches the model whatever model you point at. Pointing
  this driver at a tool-capable model does not change that, and neither does
  re-registering with `{ replace: true }` — `RegisterOptions` carries a
  `replace` flag and nothing else, so there is no seam through which to declare
  a capability the mapping does not have. If you need tools against a local
  model, reach for [an OpenAI-compatible
  endpoint](#if-you-would-rather-not-carry-the-vendor-client) instead.
- **No images or documents.** Message mapping takes text content only, so an
  attachment is never read.
- **Streaming is the whole of what it does claim**, and it is the only entry
  point.

The runtime makes the tools gap loud rather than mysterious. Registering tools
against this driver logs a capability-mismatch warning and strips every tool
surface from the prompt and the request, so the model is never told about tools
it cannot call — which is what stops a run stalling in a loop with no error to
read. `query({ …, strictCapabilities: true })` turns that warning into a
`capability_unavailable` failure. Image and document attachments raise the same
warning and fail the same way under `strictCapabilities`; there is nothing to
strip in their case, because the mapping never reads them.

Two shapes are worth knowing because they are not flags. A tool result message
whose content is structured blocks is flattened through the kernel's
`toolResultToText` before it goes on the wire, which takes text and cannot read
an array. And the final chunk carries real token counts from the daemon's
`prompt_eval_count` and `eval_count`; `cachedTokens` and `cacheWriteTokens` are
always `0`, because this API reports neither.

Finish reasons are mapped rather than assumed: a `done_reason` of `length`
arrives as `finishReason: 'length'`, which is what the run loop's
auto-continuation reads before it decides to ask for the rest of a truncated
answer. Anything unrecognised stays `'stop'`, since claiming a truncation that
did not happen would trigger a pointless continuation.

## What it refuses

The kernel's rule is that a capability accepted and then quietly not applied is
worse than one that errors, because the caller stops looking. Two requests
throw here instead of being dropped:

- **`thinking: { type: 'enabled' | 'adaptive' }`** — this driver does not
  implement extended thinking. Dropping the field would return an ordinary
  completion with an empty reasoning list, which reads as "the model did not
  reason" rather than "nobody asked it to". `{ type: 'disabled' }` and an
  absent field are accepted, because off is the state the driver is already in.
- **`effort`** — refused on the same reasoning, and it is the quieter failure
  of the two: a run someone believes they requested at `max` would be
  indistinguishable from one at the model's default.

Both are checked before the request is built, so an unreachable daemon is not
what you hear about first. The error names the driver and says what to do
instead, which is what turns a bug report about the model into a one-line
configuration change in a multi-provider setup.

## Errors and cancellation

Every failure leaves this driver as the kernel's `ProviderRequestError`,
classified into the shared taxonomy — `auth`, `throttle`, `bad_request`,
`context_overflow`, `server`, `network` — with the status where the transport
gave one and a scrubbed `detail`.

```ts
import { isProviderRequestError } from '@namzu/sdk'

import type { OllamaProvider } from '@namzu/ollama'
import type { Message } from '@namzu/sdk'

declare const provider: OllamaProvider
declare const messages: Message[]

try {
  for await (const chunk of provider.chatStream({
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'Hello' }],
  })) {
    if (chunk.delta.content) process.stdout.write(chunk.delta.content)
  }
} catch (err) {
  if (isProviderRequestError(err) && err.kind === 'context_overflow') {
    // err.status, err.detail, err.providerId
  }
}
```

The vendor error is **dropped**, not re-thrown and not attached as `cause`. The
`ollama` client promotes the response body's `error` field into its own
message, so anything the upstream echoed back — a credential a reverse proxy
was given, say — is already inside that message before this code runs, and a
`cause` is precisely what a structured logger walks. Classification is taken
from the status instead.

`retryAfterMs` is absent on a throttle from this driver, and it is the one
driver where that is unavoidable: the vendor client builds its error from the
status and body and discards the response, headers included, so the header is
gone before the driver sees the failure. Recovering it would mean stashing it
off a `fetch` wrapper, which cross-attributes under concurrent requests. An
absent value is honest; a possibly-wrong one is not.

`params.signal` is honoured end to end, and cancellation here needed more than
handing the signal down. The vendor client creates its abort controller inside
the request and exposes it only on the resolved iterator, so a stop that lands
during the initial handshake is raced: the caller returns immediately, and the
late iterator is aborted when it arrives rather than left generating. Once
streaming, the signal is wired to the iterator's own teardown — ending a
`for await` early does not release that connection by itself. On abort the
signal's own `reason` is what you catch.

This driver declares no retry defaults, so the kernel's generic retry policy
applies unchanged; a local daemon has the same failure shape the default was
written for.

## Health and model listing

- `probeCredential()` establishes **reachability, not authorisation** — a local
  daemon takes no credential, so that is the whole of what the question can
  mean here. It is declared rather than inferred: a driver that implements none
  is reported as unverifiable, never as verified.
- `listModels()` returns what the daemon has pulled, as `ModelInfo[]`.
  `inputPrice` and `outputPrice` come back `0` because there is nothing to
  bill, and `supportsToolUse` is `false` on every entry, matching what this
  driver does with tools.
- `healthCheck()` is the same probe reduced to a boolean.

All three are optional members of `LLMProvider`, so call them through the
optional chain (`await provider.probeCredential?.()`) unless you are holding
the concrete class. `doctorCheck`, `reasoningEffortLevelsFor` (and its
deprecated `effortLevelsFor` compatibility spelling), and
`resolveContextWindow` are not implemented here, and are absent rather than stubbed — the runtime
tells "this driver cannot answer" from "it answered nothing", and a stub would
destroy that distinction.

`listModels` and `probeCredential` accept an optional `AbortSignal`. The vendor
client's listing method has no signal parameter, so this driver checks authority
before the call and again before publishing its result; the CLI additionally
owns an independent deadline, so an uncooperative local call cannot hold the
picker open.

## If you would rather not carry the vendor client

Ollama also exposes an OpenAI-compatible endpoint, and
[`@namzu/http`](https://www.npmjs.com/package/@namzu/http) with `dialect:
'openai'` speaks to it with no vendor dependency at all. That path is also the
one to take when you need tool calls against a local model, since this driver
maps none. What you give up is the pieces that are specific to this wire: the
`/api/tags` model listing behind `listModels()`, and `done_reason` as the
source of the finish reason.

## Observability

There is nothing to install or enable here. The kernel emits the GenAI
semantic-convention spans and metrics around the model call itself — request
model, token usage, finish reason — so they are the same whichever driver is
underneath. Add [`@namzu/telemetry`](https://www.npmjs.com/package/@namzu/telemetry)
to export them; without an exporter installed, the OTel API's no-op defaults
discard them.

One thing this driver does not contribute: it sends no attribution header
naming the calling kernel. `OllamaConfig` carries `host`, `model`, `fetch` and
`timeout` and nothing for headers, so if you are correlating requests at a
proxy in front of the daemon, add the header yourself through `config.fetch`.
