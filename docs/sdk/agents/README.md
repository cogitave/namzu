---
title: Agents and Orchestration
description: Choose the right SDK agent class, understand delegation boundaries, and wire orchestration surfaces safely in @namzu/sdk.
last_updated: 2026-08-03
status: current
related_packages: ["@namzu/sdk"]
---

# Agents and Orchestration

`@namzu/sdk` does not ship one monolithic "agent framework". It ships a small set of execution shapes that all sit on the same runtime primitives. The important design choice is to pick the smallest orchestration surface that matches your problem.

## 1. The Mental Model

Think about the public agent surfaces in two layers:

| Layer | Owns | Main exports |
| --- | --- | --- |
| Agent class | how one run is executed | `ReactiveAgent`, `PipelineAgent`, `RouterAgent`, `SupervisorAgent`, `defineAgent()` |
| Orchestration runtime | how child work is provisioned, tracked, and persisted | `AgentManager`, `LocalTaskGateway`, invocation state, session hierarchy |

The classes are intentionally different:

- `ReactiveAgent` is the default LLM-plus-tools loop.
- `PipelineAgent` is deterministic staged code, not iterative reasoning.
- `RouterAgent` selects a downstream route.
- `SupervisorAgent` launches and coordinates sub-agent tasks.

## 2. Which Agent Should You Start With?

| Surface | Best for | Requires |
| --- | --- | --- |
| `ReactiveAgent` | most apps, tool use, model-driven iteration | provider, tools, model, runtime IDs |
| `PipelineAgent` | deterministic stages, validation, rollback | step functions, optional provider |
| `RouterAgent` | one input must be routed to one target agent | provider, routes, compatible child-agent config shape |
| `SupervisorAgent` | multi-agent task launch and coordination | provider plus either `gateway` or `agentManager` |
| `defineAgent()` | custom wrappers around the SDK result contract | you own the entire `run()` implementation |

If you are unsure, start with `ReactiveAgent`. Move up only when the runtime has a real routing or task-delegation requirement.

## 3. Minimal `ReactiveAgent` Example

This example is intentionally offline-friendly. It uses `MockLLMProvider`, so it proves agent wiring without requiring a provider package:

```ts
import {
  MockLLMProvider,
  ReactiveAgent,
  ToolRegistry,
  generateProjectId,
  generateSessionId,
  generateTenantId,
} from '@namzu/sdk'

const provider = new MockLLMProvider({
  model: 'mock-model',
  responseText: 'Reactive agent wiring is healthy.',
})

const tools = new ToolRegistry()

const agent = new ReactiveAgent({
  id: 'reactive-docs-agent',
  name: 'Reactive Docs Agent',
  version: '1.0.0',
  category: 'docs',
  description: 'Minimal reactive example for SDK docs.',
})

const result = await agent.run(
  {
    messages: [{ role: 'user', content: 'Confirm that the runtime is wired.' }],
    workingDirectory: process.cwd(),
  },
  {
    provider,
    tools,
    model: 'mock-model',
    tokenBudget: 4_096,
    timeoutMs: 30_000,
    projectId: generateProjectId(),
    sessionId: generateSessionId(),
    tenantId: generateTenantId(),
  },
)

console.log(result.status)
console.log(result.result)
```

Important boundary:

- `ReactiveAgent.run()` is the high-level entrypoint and accepts `verificationGate` directly via `ReactiveAgentConfig` (mirrors `SupervisorAgentConfig`).
- If you need `sandboxProvider`, `pluginManager`, `agentBus`, custom event streaming, or other query-only fields, drop to [Low-Level Runtime](../runtime/low-level.md).

## 4. `PipelineAgent` Is for Deterministic Stages

`PipelineAgent` is the right fit when the execution graph is known ahead of time and you do not want an LLM deciding whether to call tools:

```ts
import { PipelineAgent } from '@namzu/sdk'

const pipeline = new PipelineAgent({
  id: 'normalize-and-summarize',
  name: 'Normalize and Summarize',
  version: '1.0.0',
  category: 'workflow',
  description: 'Two fixed stages over the same input.',
})

const result = await pipeline.run(
  {
    messages: [{ role: 'user', content: '  Namzu SDK documentation  ' }],
    workingDirectory: process.cwd(),
  },
  {
    model: 'pipeline-local',
    tokenBudget: 1_024,
    timeoutMs: 5_000,
    steps: [
      {
        name: 'trim',
        execute(input) {
          return String(input).trim()
        },
      },
      {
        name: 'summarize',
        execute(input) {
          return `Normalized text: ${String(input)}`
        },
      },
    ],
  },
)

console.log(result.stepResults)
console.log(result.result)
```

Use `PipelineAgent` when:

- you need validation and optional rollback per step
- you want deterministic ordering
- "agent reasoning" would only introduce noise

## 5. `defineAgent()` Is the Escape Hatch

Use `defineAgent()` when none of the built-in agent classes matches your runtime shape:

```ts
import {
  EMPTY_TOKEN_USAGE,
  ZERO_COST,
  defineAgent,
  generateRunId,
} from '@namzu/sdk'

const checksumAgent = defineAgent({
  type: 'pipeline',
  id: 'checksum-agent',
  name: 'Checksum Agent',
  version: '1.0.0',
  category: 'utility',
  description: 'Returns a trivial size summary for the input messages.',
  async run(input) {
    const text = input.messages
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .join('\n')

    return {
      runId: generateRunId(),
      status: 'completed',
      stopReason: 'end_turn',
      usage: { ...EMPTY_TOKEN_USAGE },
      cost: { ...ZERO_COST },
      iterations: 1,
      durationMs: 0,
      messages: input.messages,
      result: `characters=${text.length}`,
    }
  },
})
```

Use this surface carefully: once you choose `defineAgent()`, you own the run semantics and result assembly yourself.

## 6. `RouterAgent` and `SupervisorAgent` Need More Intentional Wiring

These two classes are powerful, but they are not the first step.

`RouterAgent` selection flow:

1. build a route list
2. ask a provider to choose an `agentId`
3. fall back if parsing or confidence fails
4. forward the current config into the chosen child agent

That last step matters. From the current implementation, `RouterAgent` forwards the config object it received to the selected child agent after updating `invocationState`. In practice, this means route targets should share a compatible config shape or be wrapped behind a factory/manager layer that normalizes config before delegation.

`SupervisorAgent` coordination flow:

1. create coordinator tools
2. launch child tasks through a `gateway` or `agentManager`
3. keep task handles and launched-task metadata
4. run the parent loop through `drainQuery()`
5. collect child task results into the final supervisor result

Current hard requirements:

- `SupervisorAgent` requires `sessionId`, `projectId`, and `tenantId`
- it also requires either `gateway` or `agentManager`
- if you want managed child spawning, pass `agentManager`
- `ask_user_question` is registered only when both `resumeHandler` and `runId`
  are available. Its model contract requires `options` to be a JSON array of
  2–4 objects with a `label` (and optional `description`); capable providers
  constrain that shape, while the runtime decoder remains authoritative.

## 7. What `AgentManager` Actually Owns

`AgentManager` is not just a task list. It owns the boring but critical orchestration work:

- child task creation and cancellation
- budget partitioning across spawned tasks
- lineage and sub-session provisioning
- event fan-out to listeners
- waiting, continuation, and cleanup

This is why `SupervisorAgent` becomes much more useful once a real `AgentManager` is present. The manager is where the orchestration runtime turns from "one run" into "an accountable hierarchy of runs".

## 8. Invocation State Is for Runtime Context, Not Prompt Text

`InvocationState` flows through agent hierarchies and is not shown to the model. Use it for:

- tenant-scoped services
- caches or database clients
- correlation IDs
- parent agent chains for tracing

Do not confuse it with persona or system prompt text. Prompt composition belongs in [Skills and Personas](../prompting/README.md).

## 8b. One Run at a Time, and What a Retry Gets

An agent instance runs one thing at a time. `abortController` and
`currentRunId` are instance state, so two overlapping runs share one abort
controller — cancelling either kills both — and the second clobbers the
first's run id, so a later `cancel()` cancels the wrong run. Neither
failure announces itself, so a second concurrent `run()` is refused with
`ConcurrentInvocationError` instead. A host that wants parallelism
constructs a second instance, which is cheap.

That refusal is right for a *concurrent* caller and wrong for a *retrying*
one. A request goes out, the connection drops, the client retries —
without a key the retry is a second full run, with a second set of model
calls and a second set of whatever the tools did; with only the lock, the
retry gets an error instead of the answer it asked for.

```ts
await agent.run(input, { ...config, idempotencyKey: requestId })
```

A duplicate arriving while the first is still running **awaits it** and
receives its result — the error included, because both callers asked the
same question once and telling one of them something different would make
the key a lie.

**In-flight only.** A retry that arrives after the first has settled runs
again. Keeping the answer would turn deduplication into caching, and how
stale an answer may be is the host's judgement, not the SDK's.
Instance-scoped, like the lock: deduplicating across processes needs
somewhere durable to record the key, which is a store the host owns.

## 9. Common Mistakes

| Mistake | Why it hurts |
| --- | --- |
| reaching for `SupervisorAgent` too early | you inherit manager, gateway, and child-task concerns before you need them |
| assuming `RouterAgent` builds child config for you | it routes; it does not magically normalize incompatible child-agent configs |
| putting hidden runtime data into the prompt | use `InvocationState` for internal runtime context instead |
| expecting `ReactiveAgent.run()` to expose every kernel feature | query-only controls live in [Low-Level Runtime](../runtime/low-level.md) |
| treating `defineAgent()` as a shortcut | it is flexible, but you must assemble the full result contract correctly |

## Related

- [SDK Quickstart](../quickstart.md)
- [Low-Level Runtime](../runtime/low-level.md)
- [Run Configuration](../runtime/configuration.md)
- [Run Identities](../runtime/identities.md)
- [Sessions, Workspaces, and Retention](../sessions/README.md)
- [Execution Folders](../architecture/execution-folders.md)
- [ReactiveAgent Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/agents/ReactiveAgent.ts)
- [Agent Manager Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/manager/agent/lifecycle.ts)
