<!-- okf
type: Reference
title: "@namzu/sdk"
description: >-
  An agent kernel for TypeScript. Runs an agent as supervised turns of a
  session, with an identity, a budget, a permission boundary and a durable
  session log. Renders no UI, hosts no service, and has no preferred model vendor.
tags: [readme, package, sdk, agent-kernel]
status: stable
generated: { by: human:bahadirarda, at: 2026-10-13T00:00:00Z }
-->

<div align="center">

<h1>@namzu/sdk</h1>

**Run AI agents in TypeScript with a token budget, a permission gate, and a session log that survives restarts.**

[![npm](https://img.shields.io/npm/v/@namzu/sdk.svg)](https://www.npmjs.com/package/@namzu/sdk)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/packages/sdk/LICENSE.md)

</div>

## Install

```sh
pnpm add @namzu/sdk zod@^3
```

Requires `node` 20 or newer and an ESM project (`"type": "module"`). The
package also declares `@opentelemetry/api` and `zod-to-json-schema` as peer
dependencies. Install those two too if your package manager does not add peers.

## Your first agent

No API key or network is needed. The mock provider plays a scripted reply, and
the kernel runs the same turn loop it runs for a real model.

```sh
pnpm add -D tsx
```

Save this as `agent.ts`:

```ts
import { ProviderRegistry, runAgent } from '@namzu/sdk'

const { provider } = ProviderRegistry.create({ type: 'mock', responseText: 'Paris.' })
const { output, turn, identity } = await runAgent({
  provider,
  model: 'mock-model',
  prompt: 'What is the capital of France?',
})

console.log(output)          // Paris.
console.log(turn.stopReason) // end_turn
console.log(identity)        // { sessionId, topicId, projectId, tenantId }
```

Run it with `pnpm exec tsx agent.ts`. To continue the conversation, spread
`identity` into the next `runAgent` call and pass the earlier `turn.messages`.
Identity alone does not load history.
[Quick start](https://github.com/cogitave/namzu/blob/main/docs/sdk/quick-start.md).

## What you get

- **A budget that stops a turn.** Token, iteration and time limits apply to
  every turn, and child sessions share the root turn's token ledger.
  [Token budgets](https://github.com/cogitave/namzu/blob/main/docs/sdk/token-budgets.md)
- **A session record that survives the process.** Each session is one
  append-only, hash-chained JSONL file under `NAMZU_HOME`.
  [Session log](https://github.com/cogitave/namzu/blob/main/docs/sdk/session-log.md)
- **Tools that declare what they do.** Each tool states whether it is read-only,
  destructive or concurrency-safe, and which permissions it needs.
  [Tool execution](https://github.com/cogitave/namzu/blob/main/docs/sdk/tool-execution.md)
- **A permission gate before dispatch.** Undecided calls resolve under one of
  five review modes. [Review policy](https://github.com/cogitave/namzu/blob/main/docs/sdk/review-policy.md)
- **Opaque identities.** Tenant, project, topic, session and turn identifiers
  are UUIDs, checked at storage.
  [Identifiers](https://github.com/cogitave/namzu/blob/main/docs/sdk/ids.md)
- **Workspace sandboxes that refuse rather than fall back.** A turn's workspace
  is ephemeral unless `sandbox: { workspace: 'working-directory' }` is set, and
  a provider that cannot support that refuses the turn.
  [Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/runtime/query/index.ts)
- **Compaction that keeps the originals.** Removed messages are retained before
  a replacement history is published.
  [Manual compaction](https://github.com/cogitave/namzu/blob/main/docs/sdk/manual-compaction.md)

## Give the agent a tool

A tool is a `defineTool` inside a `toolset`. This example scripts two model
turns. The mock asks for `add`, the kernel runs it, and the mock gives the
final answer. No model is called.

```ts
import { defineTool, MockLLMProvider, runAgent, toolset } from '@namzu/sdk'
import { z } from 'zod'

const toolsets = [toolset('math', [defineTool({
  name: 'add',
  description: 'Add two numbers.',
  inputSchema: z.object({ a: z.number().finite(), b: z.number().finite() }),
  category: 'custom',
  permissions: [],
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  execute: async ({ a, b }) => ({ success: true, output: String(a + b) }),
})])]

const provider = new MockLLMProvider({
  turns: [
    { toolCalls: [{ name: 'add', args: { a: 20, b: 22 } }] },
    { text: '42' },
  ],
})

const { output, turn } = await runAgent({
  provider,
  model: 'mock-model',
  toolsets,
  prompt: 'Add 20 and 22.',
  maxIterations: 4,
  tokenBudget: 8192,
  timeoutMs: 30_000,
})

console.log(output) // 42
console.log(turn.messages.filter((message) => message.role === 'tool'))
```

`workingDirectory` controls where tools run; kernel state goes under
`NAMZU_HOME` (default `~/.namzu`). [Toolsets](https://github.com/cogitave/namzu/blob/main/docs/sdk/toolsets.md)
covers composing tools.

## Use a real model

Each model driver is its own package. This example uses `@namzu/anthropic` and
reads `ANTHROPIC_API_KEY` from the environment.

```sh
pnpm add @namzu/anthropic
```

```ts
import { ProviderRegistry, runAgent } from '@namzu/sdk'
import { registerAnthropic } from '@namzu/anthropic'

registerAnthropic()

const model = 'claude-sonnet-4-5-20250929'
const { provider } = ProviderRegistry.create({
  type: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  model,
})

const { output } = await runAgent({
  provider,
  model,
  prompt: 'What is the capital of France?',
})

console.log(output)
```

Your tools and `runAgent` call stay the same when you change the driver.

| Package | What it is for |
|---|---|
| `@namzu/anthropic` | Streaming, tool use and extended thinking |
| `@namzu/openai` | API-key and subscription providers, with streaming and tool use |
| `@namzu/deepseek` | Streaming, tool use and thinking mode |
| `@namzu/bedrock` | Converse API, streaming and tool use |
| `@namzu/google` | Native model API, with an OAuth sign-in |
| `@namzu/openrouter` | Many hosted models behind one key |
| `@namzu/zen` | Hosted models with native protocol routing |
| `@namzu/ollama` | Local models, no key needed |
| `@namzu/lmstudio` | Local models through a local model server, with tool use |
| `@namzu/http` | Zero-dependency driver for compatible HTTP endpoints |

Every driver registers through `ProviderRegistry`. For per-model rates and
capabilities, see [model prices](https://github.com/cogitave/namzu/blob/main/docs/sdk/model-prices.md).

## Map of the subsystems

| Area | What it covers | Guide |
|---|---|---|
| Turns | Query input, durable delivery, and schedules with catch-up | [Query](https://github.com/cogitave/namzu/blob/main/docs/sdk/query.md), [Schedules](https://github.com/cogitave/namzu/blob/main/docs/sdk/schedules.md) |
| Sessions | The append-only log, the session index, and `@namzu/sdk/testing` for custom logs | [Session log](https://github.com/cogitave/namzu/blob/main/docs/sdk/session-log.md), [Session index](https://github.com/cogitave/namzu/blob/main/docs/sdk/sqlite-sessions.md) |
| Tools | Toolsets, ordering, discovery and MCP servers | [Toolsets](https://github.com/cogitave/namzu/blob/main/docs/sdk/toolsets.md), [Discovery](https://github.com/cogitave/namzu/blob/main/docs/sdk/tool-discovery.md), [MCP](https://github.com/cogitave/namzu/blob/main/docs/sdk/mcp-toolset.md) |
| Permissions | Review modes and command-line rules | [Review policy](https://github.com/cogitave/namzu/blob/main/docs/sdk/review-policy.md), [Command lines](https://github.com/cogitave/namzu/blob/main/docs/sdk/command-lines.md) |
| Budgets | Token ledger and tool-call limits | [Token budgets](https://github.com/cogitave/namzu/blob/main/docs/sdk/token-budgets.md), [Tool calls](https://github.com/cogitave/namzu/blob/main/docs/sdk/tool-call-budget.md) |
| Context | Compaction, pinned facts and the working set | [Compaction](https://github.com/cogitave/namzu/blob/main/docs/sdk/manual-compaction.md), [Working set](https://github.com/cogitave/namzu/blob/main/docs/sdk/salience-working-set.md) |
| Memory | Typed memory records and bounded recall | [Structured memory](https://github.com/cogitave/namzu/blob/main/docs/sdk/memory.md) |
| Skills and hooks | Skill loading, lifecycle events and plugins | [Skills](https://github.com/cogitave/namzu/blob/main/docs/sdk/skills.md), [Hooks](https://github.com/cogitave/namzu/blob/main/docs/sdk/hooks.md), [Plugins](https://github.com/cogitave/namzu/blob/main/docs/sdk/plugins.md) |
| People | Questions to the user and tool handoff | [User questions](https://github.com/cogitave/namzu/blob/main/docs/sdk/user-questions.md), [Handoff](https://github.com/cogitave/namzu/blob/main/docs/sdk/tool-handoff.md) |
| Sandboxes | Egress allowlists and isolation backends | [Egress profiles](https://github.com/cogitave/namzu/blob/main/docs/sdk/sandbox-egress-profiles.md), [Container-cluster](https://github.com/cogitave/namzu/blob/main/docs/sdk/kubernetes-sandbox.md), [microVM](https://github.com/cogitave/namzu/blob/main/docs/sdk/firecracker-sandbox.md) |
| Screen and browser | Screen actions and browser tools, with host contracts | [Computer actions](https://github.com/cogitave/namzu/blob/main/docs/sdk/computer-actions.md), [Browser tools](https://github.com/cogitave/namzu/blob/main/docs/sdk/browser-tools.md) |
| Host interfaces | `@namzu/ag-ui` for streamed events and interrupts | [AG-UI clients](https://github.com/cogitave/namzu/blob/main/docs/sdk/ag-ui.md) |
| Telemetry | Exporters, in `@namzu/telemetry` | [Package README](https://github.com/cogitave/namzu/blob/main/packages/telemetry/README.md) |

## Requirements

- `node` 20 or newer, in an ESM project.
- Peers: `zod` `^3.23.0`, `@opentelemetry/api` `^1.9.0`, `zod-to-json-schema` `^3.23.0`.

## Status and versioning

Semantic versioning: any backward-incompatible change to the public API ships
as a major version, however small. Pin your dependency and read the
[changelog](https://github.com/cogitave/namzu/blob/main/packages/sdk/CHANGELOG.md).

## Documentation

- [SDK guide](https://github.com/cogitave/namzu/blob/main/docs/sdk/index.md),
  with a page for each subsystem, and the [quick start](https://github.com/cogitave/namzu/blob/main/docs/sdk/quick-start.md).
- [Host contracts of a turn](https://github.com/cogitave/namzu/blob/main/docs/sdk/host-contracts.md): carried-history repair, attachment cancellation, project instructions, session paths and topics.
- [Documentation index](https://github.com/cogitave/namzu/blob/main/docs/index.md),
  and the [terminal app](https://github.com/cogitave/namzu/blob/main/packages/cli/README.md) (`@namzu/cli`), which is built on this kernel.
- Security issues: report them privately, as the [security policy](https://github.com/cogitave/namzu/blob/main/packages/sdk/SECURITY.md) describes.
  Contributing: see the [contributing guide](https://github.com/cogitave/namzu/blob/main/packages/sdk/CONTRIBUTING.md).

## License

FSL-1.1-MIT. You may use, modify and redistribute the SDK for any purpose
except a Competing Use, as defined in the
[license](https://github.com/cogitave/namzu/blob/main/packages/sdk/LICENSE.md).
Each version of the Software becomes available under the MIT license on the
second anniversary of the date it was made available.
