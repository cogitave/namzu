---
type: Guide
title: Run the kernel
description: Start an offline SDK run, execute a tool, and retain the identity and messages needed for another turn.
resource: packages/sdk/src/agents/runAgent.ts
tags: [sdk, agent-kernel, getting-started]
status: stable
---

# Run the kernel

Namzu is an agent kernel. `@namzu/sdk` exposes its runtime in TypeScript;
`@namzu/cli` is a terminal application built on that SDK.

Install `@namzu/sdk` and its supported Zod v3 peer in an ESM project:

```bash
pnpm add @namzu/sdk zod@^3
pnpm add -D tsx
```

Save this as `agent.ts`, then run `pnpm exec tsx agent.ts`:

```ts
import { ProviderRegistry, runAgent } from '@namzu/sdk'

const { provider } = ProviderRegistry.create({ type: 'mock', responseText: 'Paris.' })
const { output, run, identity } = await runAgent({
  provider,
  model: 'mock-model',
  prompt: 'What is the capital of France?',
})

console.log(output)
console.log(run.stopReason)
console.log(identity)
```

The mock supplies the scripted answer `Paris.` without a key, network request
or inference charge. The kernel still executes its normal run lifecycle,
including budgets and persistence. The [SDK README](../../packages/sdk/README.md#run-a-tool)
also contains a complete example that executes a local tool through this loop.

`runAgent` generates missing `tenantId`, `projectId`, `topicId` and `sessionId`
values and returns all four as `identity`. They correlate the run; generating
them does not create Project, Topic or Session records in a session store.
A host using store-backed delegation supplies the identity from its actual
records.

To continue a conversation, spread the returned `identity` into the next
`runAgent` call and pass the prior `run.messages` plus a new user message as
`prompt`. Reusing identity alone does not load history. Omitting identity starts
an independent run scope.

For inference, install a provider driver and select its model explicitly.
For more runtime configuration, use `ReactiveAgent` or `query`. Unlike
`runAgent`, those entry points take the four identity fields explicitly and
do not generate missing identity.
