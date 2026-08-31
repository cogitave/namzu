---
uid: namzu.providers.deepseek
title: The DeepSeek driver — image input, thinking mode and reasoning replay
description: Reference for @namzu/deepseek — model-scoped inline image input, why thinking mode makes this a separate driver, how reasoning_content maps onto kernel reasoning blocks, and what the wire refuses.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-22T00:00:00Z
lastReviewed: 2026-08-31
resource: packages/providers/deepseek/src/client.ts
tags: [provider, deepseek, reasoning, reference]
---

# The DeepSeek driver

Implements the kernel's `LLMProvider` over DeepSeek's Chat Completions
endpoint, which is OpenAI-shaped — and then diverges in the one place that
matters, so this is its own package rather than a `baseURL` on
`@namzu/openai`.

The thinking, reasoning-replay and parameter claims on this page were measured
against the live API on 2026-08-17. The image projection and three-model
catalogue were verified against the provider's reference harness on 2026-08-22.
Where a published contract and the endpoint disagree, the disagreement is
stated rather than resolved silently.

## Why not the OpenAI driver with a baseURL

Because thinking mode is not part of that wire, and **thinking is on by
default**. A request with no `thinking` key comes back carrying
`reasoning_content`, so pointing a driver that knows nothing about that field
at this endpoint drops the model's entire chain of thought on every call, with
no error.

`@namzu/openai` handles this honestly as far as it can: it calls the SDK's
shared `assertThinkingUnsupported`, so asking it for thinking is *refused*
rather than dropped. That is the right behaviour for a driver that cannot do
it — and it also means there is no route to DeepSeek's reasoning through it.

## Install

```bash
pnpm add @namzu/sdk @namzu/deepseek
```

## Models

| Model | Notes |
|---|---|
| `deepseek-v4-flash` | text input; the smaller, faster model |
| `deepseek-v4-pro` | text input; the larger model |
| `deepseek-v4-flash-vision-exp` | text and image input; experimental vision model |

`deepseek-chat` and `deepseek-reasoner` were **discontinued on 2026-07-24**.
They are not aliases any more; a config carrying either resolves to nothing.
After a successful model-list request, the driver merges the response with this
three-model catalogue. That keeps the vision preview selectable when the
account listing endpoint lags its release while preserving unknown gateway
models without inventing modalities for them. Both listing and the
authenticated credential probe accept an optional `AbortSignal`, which is
passed to the underlying request and rechecked before a result is published.

## Image input

`DEEPSEEK_CAPABILITIES.supportsVision` is `true` because the driver now maps
image input. That is a driver-level fact, not a claim that every DeepSeek model
can see. `ModelInfo.inputModalities` marks only
`deepseek-v4-flash-vision-exp` with `['text', 'image']`; the two known text
models carry `['text']`, and unknown models omit the field.

On the vision model, user text remains first and each attachment follows as an
OpenAI-compatible `image_url` data URL. Consecutive rich tool results remain
individual `role: "tool"` messages with their exact `tool_call_id`; their
images are grouped in one following user message. This ordering preserves the
assistant call/result relationship rather than replacing a tool result with a
user attachment.

PNG, JPEG, WebP and GIF media types are accepted. The representation is the
upstream adapter's inline fallback path: this release does not upload through
the Files API, normalize pixels, or decode bytes to verify that their content
matches the declared media type. `ImageAttachment.data` therefore retains its
SDK contract: base64 image bytes without a `data:` prefix.

The SDK applies `maxRequestRichContentBytes` across user attachments and rich
tool results before this projection. Omitted-request markers stay text, while
the original image blocks remain exact in `Run.messages`, checkpoints and
session history.

The driver refuses before transport when an image targets either text model,
when a stored ref reaches it unresolved, or when the media type is outside the
four listed formats. Documents remain unsupported on every model, including in
tool results; route those turns to a document-capable driver.

## Thinking mode

`ThinkingConfig.type` maps one-to-one, which is a rename rather than a mapping:
the vendor validates `thinking.type` against `adaptive`, `enabled`, `disabled`
— its own 400 names those three — and they are the same three the SDK declares.

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerDeepSeek } from '@namzu/deepseek'

registerDeepSeek()

const { provider } = ProviderRegistry.create({
  type: 'deepseek',
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
})

for await (const chunk of provider.chatStream({
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'Is 91 prime?' }],
  // Omit this entirely and thinking is ON — that is the vendor's default,
  // not this driver's.
  thinking: { type: 'disabled' },
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

Reasoning arrives as `delta.reasoning` fragments, the same channel
`@namzu/anthropic` uses, so a host that already renders one renders the other:

```ts
import type { LLMProvider } from '@namzu/sdk'

declare const provider: LLMProvider

let thought = ''
let answer = ''
for await (const chunk of provider.chatStream({
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'Is 91 prime?' }],
})) {
  if (chunk.delta.reasoning?.text) thought += chunk.delta.reasoning.text
  if (chunk.delta.content) answer += chunk.delta.content
}
```

This wire streams reasoning as one flat run with no block boundaries, so
everything lands in block index 0. The block is closed when content or a tool
call starts — the only boundary available — and closed at the end of a turn
that produced reasoning and nothing else.

## Reasoning replay is route-bound

The vendor's rule: with tool calls in play, an assistant turn's
`reasoning_content` **must** be sent back on every later turn of the same flow,
or the request is rejected. Without tool calls it is ignored if sent.

The run loop stores two records together on the assistant message:

- readable `reasoning` blocks, which remain the durable source of truth;
- a versioned, adapter-private replay envelope under `source.replayState`,
  bound to the provider id, model, and fallback-chain member that produced it.

The driver sends `reasoning_content` again only when the source route, envelope
route, envelope version, and durable reasoning all agree with the route now
receiving the request. The same configured route still replays after process
restart, `/resume`, and `/fork`. Switching model, provider, or fallback member
keeps the assistant text and tool exchange but omits the foreign native field.
Missing, malformed, or edited replay state degrades in the same safe way.

The ordinary `query()` and CLI paths do this automatically. A host driving
`chatStream` directly must retain the response's final `replayState` together
with the matching `ProviderRoute` when it constructs the assistant history.
Matching provider and model names without the envelope are deliberately not
enough to reconstruct native state.

> **Measured, and worth knowing if you are debugging this:** as of 2026-08-17
> omitting the replay does **not** produce the documented rejection, on either
> model. The rule is followed anyway. A contract a vendor states and does not
> currently enforce is one that can start being enforced in any release, and
> the cost of honouring it is a field on a request.

`redacted_thinking` and signed blocks from another adapter are not replayed —
they are not this wire's native `reasoning_content`, and flattening them would
present foreign metadata as thought produced by this route.

## What this driver refuses

Both refusals exist because the vendor **accepts** these and applies neither.
An accepted-and-discarded parameter is the failure this repository's
`refuse-do-not-degrade` rule is about: the caller believes they set something
they did not.

| Refused | Why |
|---|---|
| `effort` | `thinking.effort` is accepted and validated against nothing — `effort: 'bogus'` returns 200, and `effort: 'none'` still produces reasoning tokens. The vendor's *Anthropic-format* endpoint does take an effort; this wire does not. |
| `temperature`, `topP`, `frequencyPenalty`, `presencePenalty`, while thinking is on | All four return 200 and change nothing. Since thinking is on by default, this fires more often than you would expect. |

The provider therefore returns an exact empty array from
`reasoningEffortLevelsFor()`, and a request that nevertheless supplies
`effort` is refused before transport. Empty is distinct from `undefined`: the
driver knows this wire has no effective levels; it is not merely missing model
metadata.

Turn thinking off for a call and the sampling parameters are honoured normally.
To send them anyway and let the vendor discard them, construct the provider
with `samplingInThinkingMode: 'ignore'`.

## Capabilities

```ts
import { DEEPSEEK_CAPABILITIES } from '@namzu/deepseek'

// supportsTools, supportsStreaming, supportsFunctionCalling and
// supportsVision and supportsToolResultImages are true;
// supportsDocuments and supportsToolResultDocuments are false.
console.log(DEEPSEEK_CAPABILITIES.supportsVision)
```

The capability says the driver has a real image mapping. The per-model
`inputModalities` list and the driver's pre-transport model guard say where that
mapping is legal. Documents remain false because no document mapping is
implemented. Tool-result capability is declared independently: an image from a
tool can use the rich-result projection described above, while a document from
a tool is refused or reported as an explicit capability mismatch rather than
being dropped.

## Cost

`@namzu/deepseek` carries no rows in the model price catalogue, deliberately,
so a run through it reports cost as unknown rather than as a number nobody
checked.

The vendor publishes two list prices per model and picks between them by the
clock: peak (01:00–04:00 and 06:00–10:00 UTC) is exactly twice off-peak, on
both input and output. A static table has no hour in it, so either figure would
be wrong for half of every day — and wrong while reading as verified. See the
`absent` note in `packages/sdk/src/pricing/rates.source.json`.

## Observability

Spans and metrics come from the kernel, not from this package. Install
`@namzu/telemetry` to export them. `usage.reasoningTokens` is surfaced
separately, because reasoning is billed as output and cannot be separated from
it afterwards — a thinking run whose reasoning dwarfs its answer otherwise
reads as an inexplicably expensive short reply.
