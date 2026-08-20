<!-- okf
type: Reference
title: "@namzu/deepseek"
description: >-
  The DeepSeek model driver for the Namzu agent kernel. Chat Completions with
  streaming and tool use, and thinking mode mapped onto the kernel's reasoning
  blocks in both directions.
tags: [readme, package, provider, deepseek]
timestamp: 2026-08-20T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/deepseek</h1>

**The DeepSeek model driver for [Namzu](https://github.com/cogitave/namzu).**

[![npm](https://img.shields.io/npm/v/@namzu/deepseek.svg)](https://www.npmjs.com/package/@namzu/deepseek)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Thinking mode](#thinking-mode) · [Documentation](#documentation)

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
  model: 'deepseek-v4-flash',
})

for await (const chunk of provider.chatStream({
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'Is 91 prime?' }],
})) {
  if (chunk.delta.reasoning?.text) process.stderr.write(chunk.delta.reasoning.text)
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

Models are `deepseek-v4-flash` and `deepseek-v4-pro`. `deepseek-chat` and
`deepseek-reasoner` were discontinued on 2026-07-24 and are not aliases.

## Thinking mode

**Thinking is on by default** — the vendor's default, not this driver's. The
chain of thought arrives as `delta.reasoning` fragments, the same channel
`@namzu/anthropic` uses. The kernel persists it with versioned adapter state and
the exact provider/model/fallback route, so the same configured route replays it
after restart or `/resume`. A model, provider, or chain-member switch keeps the
portable assistant/tool history and omits the foreign native reasoning field.

Turn it off per call with `thinking: { type: 'disabled' }`.

Two parameters are **refused** rather than sent, because the vendor accepts
them and applies neither: `effort`, and the sampling parameters while thinking
is on. Both refusals, and how to opt out, are in the documentation below.

## Documentation

- [The DeepSeek driver](https://github.com/cogitave/namzu/blob/main/docs/providers/deepseek.md) — thinking mode, reasoning replay, what this wire refuses, and why it carries no price rows
- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
