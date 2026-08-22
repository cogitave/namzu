<!-- okf
type: Reference
title: "@namzu/openai"
description: >-
  Implements the kernel's `LLMProvider` interface for OpenAI API keys and
  account-routed ChatGPT subscription sessions.
tags: [readme, package, provider, openai]
timestamp: 2026-08-22T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/openai</h1>

**OpenAI API-key and ChatGPT subscription drivers for [Namzu](https://github.com/cogitave/namzu).**

[![npm](https://img.shields.io/npm/v/@namzu/openai.svg)](https://www.npmjs.com/package/@namzu/openai)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

Implements the kernel's `LLMProvider` interface over the official OpenAI SDK.
The package has two explicit transports: `OpenAIProvider` speaks Chat
Completions with an API key, while `CodexProvider` speaks the account-routed
Responses backend with a ChatGPT subscription session. Installed only if you
use either one — the kernel has no preferred vendor and no driver is a
dependency of it.

## Install

```bash
pnpm add @namzu/sdk @namzu/openai
```

`@namzu/sdk` is a peer dependency. Install both.

## Usage

### OpenAI API key

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

### ChatGPT subscription

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerCodex } from '@namzu/openai'

declare const accessToken: string
declare const accountId: string

registerCodex()

const { provider } = ProviderRegistry.create({
  type: 'codex',
  accessToken,
  accountId,
  model: 'gpt-5.6-luna',
})
```

`accessToken` and `accountId` must come from a user-authorized ChatGPT session.
The driver does not discover, refresh or persist credentials; that ownership
belongs to the host. Namzu CLI can reuse a usable device session owned by the
Codex CLI, without copying it into Namzu's credential store, or create a
separate Namzu-owned device login when no external session is available.

## Documentation

- [The OpenAI driver — configuration, refusals and compatible endpoints](https://github.com/cogitave/namzu/blob/main/docs/providers/openai.md)
- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
