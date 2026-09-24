<!-- okf
type: Reference
title: "@namzu/anthropic"
description: >-
  The Anthropic model driver for the Namzu agent kernel. Implements
  LLMProvider over the vendor's official SDK with route-bound signed-thinking
  replay, so the kernel can resume native tool continuations safely.
tags: [readme, package, provider, anthropic]
status: stable
generated: { by: human:bahadirarda, at: 2026-08-20T00:00:00Z }
-->

<div align="center">

<h1>@namzu/anthropic</h1>

**The Anthropic model driver for [Namzu](https://github.com/cogitave/namzu).**

[![npm](https://img.shields.io/npm/v/@namzu/anthropic.svg)](https://www.npmjs.com/package/@namzu/anthropic)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

Implements the kernel's `LLMProvider` interface over the official
`@anthropic-ai/sdk`, so nothing above the driver layer knows which vendor is
answering. Installed only if you use it — the kernel has no preferred vendor
and no driver is a dependency of it.

## Install

```bash
pnpm add @namzu/sdk @namzu/anthropic
```

`@namzu/sdk` is a peer dependency. Install both.

## Usage

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

const response = await collectChatCompletion(
  provider.chatStream({
    model: 'claude-sonnet-4-5-20250929',
    messages: [{ role: 'user', content: 'Hello' }],
  }),
)
```

`chatStream` is the only model entry point; a non-streaming call is that stream
collected. In practice the kernel's turn loop calls it and hands you events.

Signed thinking and encrypted redacted blocks are persisted with versioned
adapter state plus their exact provider/model/fallback route. The same
configured route replays them after restart or `/resume`; another model,
provider, or chain member receives portable assistant/tool history without
foreign native thinking metadata.

When message caching is enabled, its final breakpoint ends before any
[request-only step context](../../../docs/sdk/step-context.md), on the stable
conversation history. The changing context remains in the request, outside that
cache boundary. Requests without step context keep their ordinary message
breakpoint; provider cache hits are not guaranteed.

Set exactly one of `apiKey` or `authToken`. The kernel's credential vault can
hold the key instead, so it never reaches the driver's config as a plain
string.

## Documentation

- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.

## Native JSON response format

Direct `chatStream` calls map `responseFormat: { type: 'json_schema', json_schema }`
to Anthropic's `output_config.format`, alongside any reasoning effort. Supply an
Anthropic-compatible JSON schema; the driver does not remove constraints.
`json_object` and `json_schema.strict: false` fail locally with a `bad_request`
provider error. The shared format name is not sent to this API.

This provider-level feature does not enable native mode in
`QueryParams.structuredOutput`; that still uses the SDK output tool. See
[structured output review and native transport](../../../docs/sdk/structured-output-review.md)
for the boundary and tested behavior.

## Thinking and effort

`thinking` on a request is an intent. The driver resolves it against the model
before it builds the request, because the vendor rejects a thinking mode the
model does not have instead of adjusting it:

- On a model with adaptive thinking only (Claude 4.7 and later), `enabled` is
  sent as `adaptive`, without its budget.
- On a model with manual thinking only (Claude 4.5 and earlier), `adaptive` is
  sent as `enabled`.
- On a model that cannot stop thinking, a `disabled` intent is left out and the
  model runs its default adaptive thinking. These are the Fable and Mythos
  families, Mythos Preview, and Opus from 5.5. On those models `effort` is the
  only thinking control.

`effort` must be a level the model accepts with the thinking that is actually
sent, or the request fails before it is sent. `provider.effortLevelsFor(model,
thinking)` returns those levels. `resolveThinkingCapability(model)` also says
whether thinking can be switched off at all (`canDisable`).

## Forced tool choice

`toolChoice: 'required'` and a named function force a tool call. The vendor
rejects both on Claude Opus 5.5, Claude Fable 5.1 and Claude Mythos 5.1, and on
any model when the request carries manual extended thinking
(`thinking: { type: 'enabled' }` as sent, after the resolution above). The
driver refuses such a request before sending it, with a `bad_request`
`ProviderRequestError` whose `providerCode` is `forced_tool_choice_unsupported`.
Use `toolChoice: 'auto'` and say in the prompt which tool to call, or
`responseFormat` for a fixed JSON shape. `'auto'` and `'none'` are accepted on
every model.

Ask before you force a step:

```ts
import { acceptsForcedToolChoice } from '@namzu/anthropic'

const toolChoice = acceptsForcedToolChoice('claude-opus-5-5') ? 'required' : 'auto'
```

Pass the thinking configuration you will send as the second argument; the
answer comes from the same resolution the request uses.
