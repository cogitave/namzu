<!-- okf
type: Reference
title: "@namzu/anthropic"
description: >-
  The Anthropic driver for @namzu/sdk. Streaming, tool use, extended thinking
  and constrained tool inputs over the Messages API, behind the same
  LLMProvider contract every other driver implements.
tags: [readme, package, provider, anthropic]
timestamp: 2026-08-17T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/anthropic</h1>

**The Anthropic driver for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk).**

[![License: FSL-1.1-MIT](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)
[![npm](https://img.shields.io/npm/v/@namzu/anthropic.svg?label=%40namzu%2Fanthropic)](https://www.npmjs.com/package/@namzu/anthropic)

[Install](#install) · [Use it](#use-it) · [Configuration](#configuration) · [Thinking](#extended-thinking) · [Strict tool inputs](#strict-tool-inputs)

</div>

---

## What this is

One of the model drivers for the Namzu kernel. It wraps the official
`@anthropic-ai/sdk` and implements `LLMProvider`, so the kernel drives it
through the same interface as every other driver and nothing above the driver
layer knows which vendor is answering.

Installed only if you use it. The kernel has no preferred vendor and no driver
is a dependency of it.

## Install

```bash
pnpm add @namzu/sdk @namzu/anthropic
```

`@namzu/sdk` is a peer dependency. Install both.

## Use it

```ts
import { ProviderRegistry, collectChatCompletion } from '@namzu/sdk'
import { registerAnthropic } from '@namzu/anthropic'

// Once, at startup. Module augmentation extends the config union, so the
// call below is fully type-narrowed on `type: 'anthropic'`.
registerAnthropic()

const { provider } = ProviderRegistry.create({
  type: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-5-20250929',
})
```

`LLMProvider` has **one** model entry point, `chatStream`. A non-streaming
call is that stream collected:

```ts
const response = await collectChatCompletion(
  provider.chatStream({
    model: 'claude-sonnet-4-5-20250929',
    messages: [{ role: 'user', content: 'Hello' }],
  }),
)
```

Or consume it as it arrives:

```ts
for await (const chunk of provider.chatStream({
  model: 'claude-sonnet-4-5-20250929',
  messages: [{ role: 'user', content: 'Tell me a story' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

In practice you rarely call the driver directly — the kernel's run loop does,
and hands you events. This is the shape when you do.

## Authentication

Exactly one of `apiKey` or `authToken` must be set.

| Field | For |
|---|---|
| `apiKey` | a console key (`sk-ant-api-*`), sent as `x-api-key` |
| `authToken` | an OAuth access token, sent as `Authorization: Bearer …` |

Conventionally the key comes from `ANTHROPIC_API_KEY`. The kernel's credential
vault can hold it instead, so it never has to reach the driver's config as a
plain string.

## Configuration

| Option | Default | Notes |
|---|---|---|
| `apiKey` | — | mutually exclusive with `authToken` |
| `authToken` | — | OAuth bearer token |
| `model` | — | default model when a call omits one |
| `maxTokens` | `64000` | the Messages API requires the field; this is the fallback |
| `baseURL` | vendor default | a proxy or a compatible gateway |
| `timeout` | SDK default | request timeout, ms |
| `streamIdleTimeoutMs` | disabled | per-event idle watchdog, for failing a stalled stream independently of the request timeout |
| `defaultHeaders` | — | appended to every request |
| `strictToolUse` | `'auto'` | see below |

For AWS Bedrock or Vertex access prefer the dedicated driver over a `baseURL`
override — they carry the auth and region semantics natively.

## Extended thinking

`resolveEffort`, `resolveThinkingBody` and `resolveThinkingCapability` are
exported so a host can see how a requested reasoning effort maps onto the
vendor's thinking parameters before a call is made, rather than inferring it
from the response.

## Strict tool inputs

A tool that declares `modelInputSchema` **and** `enforceModelInput: true` is
sent with `strict: true` on recognised Claude 4.5+ models, which constrains
generation to the schema instead of validating after the fact.

`strictToolUse` decides when that happens: `'auto'` (the default) enables it
for known model identifiers, `'on'` opts a compatible proxy alias in, `'off'`
disables it. Zod validation still runs on every tool call either way — strict
generation narrows what the model can emit; it does not replace the check.

The kernel refuses a schema outside the strict subset at registration rather
than sending it, because the vendor rejects the whole request when one keyword
is unexpressible and the turn dies before a token is produced.

## Capabilities

```ts
import { ANTHROPIC_CAPABILITIES } from '@namzu/anthropic'

// {
//   supportsTools: true,
//   supportsStreaming: true,
//   supportsFunctionCalling: true,
//   supportsVision: true,
//   supportsDocuments: true,
// }
```

## Observability

Spans and metrics come from the kernel, not from this package — it is a driver,
and instrumenting each one separately would report the same call under as many
names as there are vendors. Install
[`@namzu/telemetry`](https://www.npmjs.com/package/@namzu/telemetry) to export
them.

## License

FSL-1.1-MIT, converting to MIT two years after each release. Same as
`@namzu/sdk`.
