<!-- okf
type: Reference
title: "@namzu/openrouter"
description: >-
  Implements the kernel's `LLMProvider` interface over OpenRouter, which
  fronts many vendors behind one key and one wire format.
tags: [readme, package, provider, openrouter]
timestamp: 2026-08-17T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/openrouter</h1>

**The OpenRouter model driver for [Namzu](https://github.com/cogitave/namzu).**

[![npm](https://img.shields.io/npm/v/@namzu/openrouter.svg)](https://www.npmjs.com/package/@namzu/openrouter)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

Implements the kernel's `LLMProvider` interface over OpenRouter, which
fronts many vendors behind one key and one wire format. Installed only if
you use it — the kernel has no preferred vendor and no driver is a
dependency of it.

## Install

```bash
pnpm add @namzu/sdk @namzu/openrouter
```

`@namzu/sdk` is a peer dependency. Install both.

## Usage

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOpenRouter } from '@namzu/openrouter'

registerOpenRouter() // once, at startup

const { provider } = ProviderRegistry.create({
  type: 'openrouter',
  apiKey: process.env.OPENROUTER_API_KEY ?? '',
  siteUrl: 'https://example.com', // optional
  siteName: 'Example',            // optional
})

for await (const chunk of provider.chatStream({
  model: 'anthropic/claude-opus-5',
  messages: [{ role: 'user', content: 'Hello' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

`chatStream` is the only model entry point; a non-streaming call is that
stream collected. In practice the kernel's run loop calls it and hands you
events.

## Documentation

- [The OpenRouter driver — models, the window, credentials and attribution](https://github.com/cogitave/namzu/blob/main/docs/providers/openrouter.md)
- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
