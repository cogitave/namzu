<!-- okf
type: Reference
title: "@namzu/sdk"
description: >-
  An agent kernel for TypeScript. Runs an agent as a supervised unit of work
  with an identity, a budget, a permission boundary and a durable record.
  Renders no UI, hosts no service, and has no preferred model vendor.
tags: [readme, package, sdk, agent-kernel]
timestamp: 2026-08-17T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/sdk</h1>

**An agent kernel for TypeScript.**

[![npm](https://img.shields.io/npm/v/@namzu/sdk.svg)](https://www.npmjs.com/package/@namzu/sdk)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Quick start](#quick-start) · [What you get](#what-you-get) · [Documentation](#documentation)

</div>

---

An agent that works in a demo is a loop around a model call. An agent that
works in production is that loop plus everything around it — a budget that
stops it, an identity that attributes it, a boundary it cannot talk its way
past, a record that survives the process, and a way to shrink a conversation
that is about to overflow without corrupting it.

This is those other things. It runs an agent the way an operating system runs
a process: given an identity and a budget, confined, scheduled, checkpointed,
and what it did is written down. It renders no UI, requires no database, hosts
no service, and has no preferred model vendor.

## Install

```bash
pnpm add @namzu/sdk
```

Requires Node.js 20+, ESM, and TypeScript strict mode.

The kernel ships alone. Add a driver for whichever backend you use —
[`@namzu/anthropic`](https://www.npmjs.com/package/@namzu/anthropic),
[`@namzu/openai`](https://www.npmjs.com/package/@namzu/openai),
[`@namzu/bedrock`](https://www.npmjs.com/package/@namzu/bedrock),
[`@namzu/openrouter`](https://www.npmjs.com/package/@namzu/openrouter),
[`@namzu/ollama`](https://www.npmjs.com/package/@namzu/ollama),
[`@namzu/lmstudio`](https://www.npmjs.com/package/@namzu/lmstudio),
or the zero-dependency [`@namzu/http`](https://www.npmjs.com/package/@namzu/http).
With none of them the kernel still runs against `MockLLMProvider`, which is
pre-registered and scriptable.

## Quick start

```ts
import { defineTool, ProviderRegistry, ReactiveAgent, ToolRegistry } from '@namzu/sdk'
import { registerOpenRouter } from '@namzu/openrouter'
import { z } from 'zod'

registerOpenRouter()

const searchWeb = defineTool({
  name: 'search_web',
  description: 'Search the web for information',
  inputSchema: z.object({ query: z.string() }),
  category: 'network',
  permissions: ['network_access'],
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  execute: async ({ query }) => {
    const r = await fetch(`https://api.search.com?q=${query}`)
    return { success: true, output: await r.text() }
  },
})

const { provider } = ProviderRegistry.create({
  type: 'openrouter',
  apiKey: process.env.OPENROUTER_KEY ?? '',
})

const tools = new ToolRegistry()
tools.register(searchWeb)

const agent = new ReactiveAgent({
  id: 'researcher',
  name: 'Research Assistant',
  version: '1.0.0',
  category: 'research',
  description: 'Finds and synthesizes information',
})

const result = await agent.run(
  {
    messages: [{ role: 'user', content: 'Summarize the latest LLM benchmarks' }],
    workingDirectory: process.cwd(),
  },
  { model: 'anthropic/claude-sonnet-4', tokenBudget: 8192, timeoutMs: 600_000, provider, tools },
)
```

That run is sandbox-isolated, checkpointed and instrumented, with prompt
caching, progressive tool disclosure and structured compaction already wired
in. Those are not features you enable — they are how the kernel runs. Swap the
`registerOpenRouter()` line for any other driver and everything below it is
unchanged.

## What you get

| | |
|---|---|
| **Boundary** | tool calls run confined; a permission gate decides before, not after |
| **Budget** | tokens, money, wall clock and iterations, enforced rather than hoped for |
| **Identity** | tenant → project → topic → session → run, on every record and span |
| **Durability** | checkpoints a run resumes from, and a record that outlives the process |
| **Compaction** | a conversation about to overflow is shrunk without being corrupted |
| **Observability** | OpenTelemetry spans and metrics, and a log pipeline you own the sink for |

`TopicManager` is the lifecycle authority for the durable subject above a
session. Supply it to agent and handoff dependencies as `topicManager`; spawn
and handoff then share the same archived-topic gate. Hosts can distinguish
`TopicArchivedError`, `TopicNotEmptyError`, and `StaleTopicError` directly from
the package root, and each carries `details.topicId`.

## Documentation

- [The kernel in depth](https://github.com/cogitave/namzu/blob/main/docs/sdk/architecture.md) — every subsystem, the design principles, the event protocol
- [An agent is a folder](https://github.com/cogitave/namzu/blob/main/docs/sdk/directory/agent-as-a-directory.md)
- [Tools and safety](https://github.com/cogitave/namzu/tree/main/docs/sdk/tools) · [Observability](https://github.com/cogitave/namzu/tree/main/docs/sdk/observability) · [Integrations](https://github.com/cogitave/namzu/tree/main/docs/sdk/integrations)
- [All docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
