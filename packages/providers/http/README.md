<!-- okf
type: Reference
title: "@namzu/http"
description: >-
  Implements the kernel's `LLMProvider` interface over a plain HTTP
  endpoint. Speaks two wire dialects and refuses a mismatch rather than
  guessing which one a gateway meant.
tags: [readme, package, provider, http]
status: stable
generated: { by: human:bahadirarda, at: 2026-08-17T00:00:00Z }
-->

<div align="center">

<h1>@namzu/http</h1>

**The HTTP model driver for [Namzu](https://github.com/cogitave/namzu).**

[![npm](https://img.shields.io/npm/v/@namzu/http.svg)](https://www.npmjs.com/package/@namzu/http)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

Implements the kernel's `LLMProvider` interface over a plain HTTP endpoint.
Speaks two wire dialects and refuses a mismatch rather than guessing which
one a gateway meant. Installed only if you use it — the kernel has no
preferred vendor and no driver is a dependency of it.

## Install

```bash
pnpm add @namzu/sdk @namzu/http
```

`@namzu/sdk` is a peer dependency. Install both.

## Usage

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerHttp } from '@namzu/http'

registerHttp() // once, at startup

const { provider } = ProviderRegistry.create({
  type: 'http',
  baseURL: 'http://localhost:8000/v1',
  apiKey: process.env.INFERENCE_TOKEN ?? '',
  dialect: 'openai',
})

for await (const chunk of provider.chatStream({
  model: 'my-served-model',
  messages: [{ role: 'user', content: 'Hello' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

`chatStream` is the only model entry point; a non-streaming call is that
stream collected. In practice the kernel's run loop calls it and hands you
events.

## Documentation

- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
