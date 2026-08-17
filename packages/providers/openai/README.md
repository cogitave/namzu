<!-- okf
type: Reference
title: "@namzu/openai"
description: >-
  Implements the kernel's `LLMProvider` interface over the official OpenAI
  SDK, and over any endpoint that speaks the same wire format.
tags: [readme, package, provider, openai]
timestamp: 2026-08-17T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/openai</h1>

**The OpenAI model driver for [Namzu](https://github.com/cogitave/namzu).**

[![npm](https://img.shields.io/npm/v/@namzu/openai.svg)](https://www.npmjs.com/package/@namzu/openai)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

Implements the kernel's `LLMProvider` interface over the official OpenAI
SDK, and over any endpoint that speaks the same wire format. Installed only
if you use it — the kernel has no preferred vendor and no driver is a
dependency of it.

## Install

```bash
pnpm add @namzu/sdk @namzu/openai
```

`@namzu/sdk` is a peer dependency. Install both.

## Usage

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOpenAI } from '@namzu/openai'

// Once, at startup.
registerOpenAI()

const { provider } = ProviderRegistry.create({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini', // default; overridable per call
})

for await (const chunk of provider.chatStream({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

`chatStream` is the only model entry point; a non-streaming call is that
stream collected. In practice the kernel's run loop calls it and hands you
events.

## Documentation

- [The OpenAI driver — configuration, refusals and compatible endpoints](https://github.com/cogitave/namzu/blob/main/docs/providers/openai.md)
- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
