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

`runAgent` fills in missing identity and returns all four fields as
`identity`. `tenantId`, `topicId` and `sessionId` are generated per call.
`projectId` is derived from `workingDirectory` by `projectIdForDirectory`, so
every run in one directory is filed under one Project and the durable layout
(`projects/<projectId>/…`) gains one tree per directory rather than one per
call. None of this creates Project, Topic or Session records in a session
store. A host using store-backed delegation supplies the identity from its
actual records.

`runAgent` defaults to 16 main-loop iterations, 200,000 cumulative tokens and
five minutes. Set `maxIterations: 0`, `tokenBudget: 0` and `timeoutMs: 0` to
disable those guards explicitly. Usage and cancellation remain active; see
[Token budgets](token-budgets.md) for descendant accounting and receipt handling.

To continue a conversation, spread the returned `identity` into the next
`runAgent` call and pass the prior `run.messages` plus a new user message as
`prompt`. Reusing identity alone does not load history. Omitting identity starts
a new session in the working directory's Project.

For inference, install a provider driver and select its model explicitly.
For more runtime configuration, use `ReactiveAgent` or `query`. Unlike
`runAgent`, those entry points take the four identity fields explicitly and
do not generate missing identity.

## Keep execution state outside working files

`workingDirectory` controls where tools execute. It does not have to be the
storage root. Pass a `pathBuilder` to keep checkpoints, run evidence and other
runtime files outside the workspace a model searches:

```ts
import { DefaultPathBuilder, MockLLMProvider, runAgent } from '@namzu/sdk'

const result = await runAgent({
  provider: new MockLLMProvider({ responseText: 'ready' }),
  model: 'mock-model',
  prompt: 'Say ready.',
  workingDirectory: '/absolute/path/workspace',
  pathBuilder: new DefaultPathBuilder('/absolute/path/private-runtime-state'),
})
```

The host owns those paths and their permissions. An omitted builder retains the
SDK's existing `{workingDirectory}/.namzu` layout; the CLI supplies its separate
application layout. The SDK also accepts the existing `runStore` and
`checkpointStore` contracts for custom evidence and checkpoint persistence.
Set both when both kinds of records must use another backend. Injecting a store
does not replace every other runtime path; use a builder as well when the
workspace must remain free of generated state. In-memory stores are deliberately
not durable. Advanced leased recovery and fencing still use the lower-level
query/recovery APIs.

For evaluation, use fresh histories and keep generated runtime files outside
searched fixtures. Otherwise later cases can encounter earlier transcripts even
when their message history is empty.
