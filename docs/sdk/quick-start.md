---
type: Guide
title: Run the kernel
description: Start an offline SDK turn, execute a tool, and retain the identity and messages needed for the next turn.
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
const { output, turn, identity } = await runAgent({
  provider,
  model: 'mock-model',
  prompt: 'What is the capital of France?',
})

console.log(output)
console.log(turn.stopReason)
console.log(identity)
```

The mock supplies the scripted answer `Paris.` without a key, network request
or inference charge. The kernel still executes its normal turn lifecycle,
including budgets and persistence. The [SDK README](../../packages/sdk/README.md#run-a-tool)
also contains a complete example that executes a local tool through this loop.

`runAgent` fills in missing identity and returns all four fields as
`identity`. `tenantId`, `topicId` and `sessionId` are generated per call.
`projectId` is the project of `workingDirectory`: minted once into
`<NAMZU_HOME>/projects/<slug>/project.json` by `ensureProject` and adopted by
every later call there, so every session in one directory is filed under one
Project, in one tree. None of this creates Project, Topic or Session records in a session
store. These generated IDs are correlation and storage labels, not ownership
or permission claims. A host using store-backed delegation supplies the
identity from its actual records.

`runAgent` defaults to 16 main-loop iterations, 200,000 cumulative tokens and
five minutes. Set `maxIterations: 0`, `tokenBudget: 0` and `timeoutMs: 0` to
disable those guards explicitly. Usage and cancellation remain active; see
[Token budgets](token-budgets.md) for descendant accounting and receipt handling.

To continue a conversation, spread the returned `identity` into the next
`runAgent` call and pass the prior `turn.messages` plus a new user message as
`prompt`. Reusing identity alone does not load history. Omitting identity starts
a new session in the working directory's Project. If you reuse a `sessionId`,
pass the same project, tenant and topic IDs too: an existing session refuses
a turn attributed to a different scope.

For inference, install a provider driver and select its model explicitly.
For more runtime configuration, use `QueryAgent` or `query`. Unlike
`runAgent`, they do not generate missing identity: `query` takes the four
fields explicitly, and a managed `QueryAgent` takes their complete scope on
`ManagedAgentInput.managedScope` (with the config fields still accepted for existing
callers).

`QueryAgent` is an optional adapter for hosts that need an `Agent` instance
inside `AgentManager`. For an application-specific agent, implement the SDK's
`Agent` contract or use `defineAgent`; choose any `type` string. See
[Agent ownership](agent-ownership.md) for the division between the SDK, CLI
and example orchestration patterns.

## Where the session is recorded

`workingDirectory` controls where tools execute; it is never where generated
state goes. Each call is one turn of a session, recorded in one append-only
log under `NAMZU_HOME` (default `~/.namzu`):
`projects/<slug>/<session-id>.jsonl`, where the slug is the working
directory's canonical path with every character outside `[A-Za-z0-9]` replaced
by `-`. Checkpoints, the token ledger, tasks and tool-result spills sit beside
it in `projects/<slug>/<session-id>/`. See [Session log](session-log.md) for
the layout and the record schema.

To put that state somewhere else, set `NAMZU_HOME`, or pass `paths`, a
`SessionPaths` rooted where you choose:

```ts
import { ensureProject, MockLLMProvider, runAgent, SessionPaths } from '@namzu/sdk'

const home = '/absolute/path/private-runtime-state'
const workingDirectory = '/absolute/path/workspace'
const project = await ensureProject({ home, cwd: workingDirectory })

const result = await runAgent({
  provider: new MockLLMProvider({ responseText: 'ready' }),
  model: 'mock-model',
  prompt: 'Say ready.',
  workingDirectory,
  projectId: project.projectId,
  paths: new SessionPaths({ home, slug: project.slug }),
})
```

To keep a session entirely in memory — tests, evaluation, a host with its own
persistence — pass an `InMemorySessionLog` as `sessionLog` and no `paths`: its
checkpoints, ledger and child sessions stay in memory with it, and nothing is
written anywhere. A custom backend implements `SessionLog` and is checked with
`defineSessionLogConformance` from `@namzu/sdk/testing`. Advanced leased
recovery and fencing use `claimSession`, `resumeSession` and `abandonTurn`.

For evaluation, use a fresh session per case and keep generated state outside
searched fixtures. Otherwise later cases can encounter earlier sessions' files
even when their message history is empty.
