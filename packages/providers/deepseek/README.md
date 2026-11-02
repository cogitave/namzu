<!-- okf
type: Reference
title: "@namzu/deepseek"
description: >-
  The DeepSeek model driver for the Namzu agent kernel. Chat Completions with
  streaming, tool use and inline image input, with thinking mode mapped onto
  the kernel's reasoning blocks in both directions.
tags: [readme, package, provider, deepseek]
status: stable
generated: { by: human:bahadirarda, at: 2026-08-20T00:00:00Z }
-->

<div align="center">

<h1>@namzu/deepseek</h1>

**The DeepSeek model driver for [Namzu](https://github.com/cogitave/namzu).**

[![npm](https://img.shields.io/npm/v/@namzu/deepseek.svg)](https://www.npmjs.com/package/@namzu/deepseek)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Image input](#image-input) · [Thinking mode](#thinking-mode) · [Documentation](#documentation)

</div>

---

Implements the kernel's `LLMProvider` over DeepSeek's Chat Completions
endpoint, which is OpenAI-shaped — and then diverges where it counts, which is
why this is its own package rather than a `baseURL` on `@namzu/openai`.
Installed only if you use it; the kernel has no preferred vendor.

## Install

```bash
pnpm add @namzu/sdk @namzu/deepseek
```

`@namzu/sdk` is a peer dependency. Install both. Requires Node.js 20+.

## Usage

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerDeepSeek } from '@namzu/deepseek'

registerDeepSeek() // once, at startup

const { provider } = ProviderRegistry.create({
  type: 'deepseek',
  apiKey: process.env.DEEPSEEK_API_KEY ?? '',
  model: 'deepseek-flash',
})

for await (const chunk of provider.chatStream({
  model: 'deepseek-flash',
  messages: [{ role: 'user', content: 'Is 91 prime?' }],
})) {
  if (chunk.delta.reasoning?.text) process.stderr.write(chunk.delta.reasoning.text)
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

The built-in catalogue offers `deepseek-flash` (the current Flash model, which
takes images), `deepseek-v4-pro` (text only), and the legacy names
`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp`, which the vendor still
serves from the Flash model. `deepseek-chat` and `deepseek-reasoner` were
discontinued on 2026-07-24 and are not aliases.

## Context window

The vendor documents a 1M-token context and a 384K-token output cap for every
current model (one row for `deepseek-flash` and `deepseek-v4-pro` on
https://api-docs.deepseek.com/quick_start/pricing). The driver asks the models
endpoint first and uses its `context_window` and `max_output_tokens` when the
vendor returns them; those two fields are optional there, so the documented
limits are only the fallback for the ids the driver lists, and only on the vendor's own host: behind a custom `baseURL` the driver
offers just what the listing reports. The runtime measures
compaction against that window, so the first summary is due at 967,000 tokens,
not at the 32,000 that a 64,000-token guess produced. An id the driver neither
lists nor was told about is left to the SDK's table, which keeps a conservative
64,000 for it.

## Image input

`deepseek-flash` and the legacy `deepseek-v4-flash-vision-exp` accept images. User attachments are sent
as ordered `image_url` data-URL parts. Images returned by tools keep their
`role: "tool"` result and follow it in a separate user image message, so the
tool-call/result sequence remains valid. PNG, JPEG, WebP and GIF are accepted.

The SDK's accumulated request-rich-content budget still applies before this
projection and leaves the turn's durable messages unchanged. This driver currently
uses inline base64 only; it does not upload through the Files API or claim to
normalize or decode caller-supplied image bytes. Documents, unresolved stored
refs, unsupported image types, and images sent to either text model are refused
before transport.

## Thinking mode

**Thinking is on by default** — the vendor's default, not this driver's. The
chain of thought arrives as `delta.reasoning` fragments, the same channel
`@namzu/anthropic` uses. The kernel persists it with versioned adapter state and
the exact provider/model/fallback route, so the same configured route replays it
after restart or `/resume`. A model, provider, or chain-member switch keeps the
portable assistant/tool history and omits the foreign native reasoning field.

Turn it off per call with `thinking: { type: 'disabled' }`.

### Effort

Effort rides on `reasoning_effort`, the field the vendor documents, beside
`thinking`. The vendor offers `low`, `high` and `max` (default `high`); the
models endpoint's `effort.supported_levels` and `default_level` are read once
per session and published through `reasoningEffortLevelsFor` and
`reasoningEffortDefaultFor` (plus `none`, which turns thinking off). Namzu's
wider vocabulary goes through the vendor's own mapping: `minimal` to `low`,
`medium` and `xhigh` to `high`, `ultra` to `max`. If the model's menu lacks the
mapped level, the nearest offered one is sent, the lower one on a tie
(`resolveDeepSeekEffort` says which). `none` is sent as
`thinking: { type: 'disabled' }`, and an explicit `thinking: disabled` wins over
a level, as it does at the vendor. Without `maxTokens` the vendor's default
output is 64K in thinking mode and 128K at `max`.

The sampling parameters (`temperature`, `topP` and the two penalties) are
**refused** while thinking is on, because the vendor accepts them and applies
none; `samplingInThinkingMode: 'ignore'` sends them anyway.

## Documentation

- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
