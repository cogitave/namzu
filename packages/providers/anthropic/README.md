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
collected. In practice the kernel's run loop calls it and hands you events.

Signed thinking and encrypted redacted blocks are persisted with versioned
adapter state plus their exact provider/model/fallback route. The same
configured route replays them after restart or `/resume`; another model,
provider, or chain member receives portable assistant/tool history without
foreign native thinking metadata.

Set exactly one of `apiKey` or `authToken`. The kernel's credential vault can
hold the key instead, so it never reaches the driver's config as a plain
string.

## Documentation

- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
