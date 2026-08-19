---
uid: namzu.providers.deepseek
title: The DeepSeek driver — thinking mode, reasoning replay and what this wire refuses
description: Reference for @namzu/deepseek — why thinking mode makes this a separate package rather than a base-URL override on the OpenAI driver, how reasoning_content maps onto the kernel reasoning blocks both ways, and the two parameters it refuses.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-19T00:00:00Z
lastReviewed: 2026-08-19
resource: packages/providers/deepseek/src/client.ts
tags: [provider, deepseek, reasoning, reference]
---

# The DeepSeek driver

Implements the kernel's `LLMProvider` over DeepSeek's Chat Completions
endpoint, which is OpenAI-shaped — and then diverges in the one place that
matters, so this is its own package rather than a `baseURL` on
`@namzu/openai`.

Every claim on this page was measured against the live API on 2026-08-17. Where
the vendor's documentation and the endpoint disagree, the disagreement is
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
| `deepseek-v4-flash` | the smaller, faster model |
| `deepseek-v4-pro` | the larger one |

`deepseek-chat` and `deepseek-reasoner` were **discontinued on 2026-07-24**.
They are not aliases any more; a config carrying either resolves to nothing.
The live model listing returns exactly the two names above.
Both that listing and the authenticated credential probe accept an optional
`AbortSignal`, which is passed to the underlying request and rechecked before a
result is published.

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

## Reasoning is replayed, and you do not have to do it

The vendor's rule: with tool calls in play, an assistant turn's
`reasoning_content` **must** be sent back on every later turn of the same flow,
or the request is rejected. Without tool calls it is ignored if sent.

This driver replays unconditionally, reading `AssistantMessage.reasoning` —
which the SDK already documents as "replayed verbatim and ahead of the text and
tool blocks". Nothing is asked of the caller: hand back the assistant message
you were given and the field goes with it.

> **Measured, and worth knowing if you are debugging this:** as of 2026-08-17
> omitting the replay does **not** produce the documented rejection, on either
> model. The rule is followed anyway. A contract a vendor states and does not
> currently enforce is one that can start being enforced in any release, and
> the cost of honouring it is a field on a request.

`redacted_thinking` blocks are not replayed — they carry no readable text, and
sending the placeholder would put it into the model's context as though it were
thought.

## What this driver refuses

Both refusals exist because the vendor **accepts** these and applies neither.
An accepted-and-discarded parameter is the failure this repository's
`refuse-do-not-degrade` rule is about: the caller believes they set something
they did not.

| Refused | Why |
|---|---|
| `effort` | `thinking.effort` is accepted and validated against nothing — `effort: 'bogus'` returns 200, and `effort: 'none'` still produces reasoning tokens. The vendor's *Anthropic-format* endpoint does take an effort; this wire does not. |
| `temperature`, `topP`, `frequencyPenalty`, `presencePenalty`, while thinking is on | All four return 200 and change nothing. Since thinking is on by default, this fires more often than you would expect. |

Turn thinking off for a call and the sampling parameters are honoured normally.
To send them anyway and let the vendor discard them, construct the provider
with `samplingInThinkingMode: 'ignore'`.

## Capabilities

```ts
import { DEEPSEEK_CAPABILITIES } from '@namzu/deepseek'

// supportsTools, supportsStreaming and supportsFunctionCalling are true;
// supportsVision and supportsDocuments are false.
console.log(DEEPSEEK_CAPABILITIES.supportsVision)
```

The wire has `image_url` content parts, because it is OpenAI's. The models
behind it are text-only. A capability set is a claim about what a call will do,
not about what the request format can express, so this driver refuses a message
carrying attachments rather than encoding an image the model cannot read.

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
