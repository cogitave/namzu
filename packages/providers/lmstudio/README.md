<!-- okf
type: Reference
title: "@namzu/lmstudio"
description: >-
  Implements the kernel's `LLMProvider` interface over a local LM Studio
  server, so a run can be driven by a model on your own machine with no key
  and no egress.
tags: [readme, package, provider, lmstudio]
timestamp: 2026-08-17T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/lmstudio</h1>

**The LM Studio model driver for [Namzu](https://github.com/cogitave/namzu).**

[![npm](https://img.shields.io/npm/v/@namzu/lmstudio.svg)](https://www.npmjs.com/package/@namzu/lmstudio)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

Implements the kernel's `LLMProvider` interface over a local LM Studio
server, so a run can be driven by a model on your own machine with no key
and no egress. Installed only if you use it — the kernel has no preferred
vendor and no driver is a dependency of it.

## Install

```bash
pnpm add @namzu/sdk @namzu/lmstudio
```

`@namzu/sdk` is a peer dependency. Install both.

## Usage

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerHttp } from '@namzu/http'

registerHttp()

const { provider } = ProviderRegistry.create({
  type: 'http',
  baseURL: 'http://localhost:1234/v1',
  dialect: 'openai',
})
```

`chatStream` is the only model entry point; a non-streaming call is that
stream collected. In practice the kernel's run loop calls it and hands you
events.

## Documentation

- [The LM Studio driver — the local server, configuration and cost](https://github.com/cogitave/namzu/blob/main/docs/providers/lmstudio.md)
- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
