<!-- okf
type: Reference
title: "@namzu/bedrock"
description: >-
  Implements the kernel's `LLMProvider` interface over AWS Bedrock, carrying
  the region and credential semantics natively rather than as a base-URL
  override.
tags: [readme, package, provider, bedrock]
timestamp: 2026-08-17T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/bedrock</h1>

**The Bedrock model driver for [Namzu](https://github.com/cogitave/namzu).**

[![npm](https://img.shields.io/npm/v/@namzu/bedrock.svg)](https://www.npmjs.com/package/@namzu/bedrock)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

Implements the kernel's `LLMProvider` interface over AWS Bedrock, carrying
the region and credential semantics natively rather than as a base-URL
override. Installed only if you use it — the kernel has no preferred vendor
and no driver is a dependency of it.

## Install

```bash
pnpm add @namzu/sdk @namzu/bedrock
```

`@namzu/sdk` is a peer dependency. Install both.

## Usage

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerBedrock } from '@namzu/bedrock'

registerBedrock() // once, at startup

const { provider } = ProviderRegistry.create({
  type: 'bedrock',
  region: 'us-east-1',
})

for await (const chunk of provider.chatStream({
  model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  messages: [{ role: 'user', content: 'Hello' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

`chatStream` is the only model entry point; a non-streaming call is that
stream collected. In practice the kernel's run loop calls it and hands you
events.

## Documentation

- [The AWS Bedrock driver — model ids, credentials and prompt caching](https://github.com/cogitave/namzu/blob/main/docs/providers/bedrock.md)
- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
