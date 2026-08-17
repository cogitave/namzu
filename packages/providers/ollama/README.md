<!-- okf
type: Reference
title: "@namzu/ollama"
description: >-
  Implements the kernel's `LLMProvider` interface over a local Ollama
  server, so a run can be driven by a model on your own machine with no key
  and no egress.
tags: [readme, package, provider, ollama]
timestamp: 2026-08-17T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/ollama</h1>

**The Ollama model driver for [Namzu](https://github.com/cogitave/namzu).**

[![npm](https://img.shields.io/npm/v/@namzu/ollama.svg)](https://www.npmjs.com/package/@namzu/ollama)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

Implements the kernel's `LLMProvider` interface over a local Ollama server,
so a run can be driven by a model on your own machine with no key and no
egress. Installed only if you use it — the kernel has no preferred vendor
and no driver is a dependency of it.

## Install

```bash
pnpm add @namzu/sdk @namzu/ollama
```

`@namzu/sdk` is a peer dependency. Install both.

## Usage

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOllama } from '@namzu/ollama'

// Once, at startup.
registerOllama()

const { provider } = ProviderRegistry.create({
  type: 'ollama',
  model: 'llama3.2', // default; overridable per call
})

for await (const chunk of provider.chatStream({
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'Hello' }],
})) {
  if (chunk.delta.content) process.stdout.write(chunk.delta.content)
}
```

`chatStream` is the only model entry point; a non-streaming call is that
stream collected. In practice the kernel's run loop calls it and hands you
events.

## Documentation

- [The Ollama driver — configuration, refusals and cancellation](https://github.com/cogitave/namzu/blob/main/docs/providers/ollama.md)
- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
