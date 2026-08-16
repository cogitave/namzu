---
title: Low-Level Runtime
description: Use query() and drainQuery() directly in @namzu/sdk when you need plugin wiring, an agent bus, a prompt cache, or generator-level RunEvent streaming — the runtime controls ReactiveAgentConfig does not surface.
last_updated: 2026-08-16
status: current
related_packages: ["@namzu/sdk", "@namzu/openai"]
---

# Low-Level Runtime

`ReactiveAgent.run()` is the best default for most users, but it is intentionally not the entire kernel surface. The lower-level runtime entrypoints are `query()` and `drainQuery()`. Use them when you need features that live below the high-level agent wrappers.

## 1. When to Drop Below `ReactiveAgent`

Use the low-level runtime when you need:

- direct `RunEvent` streaming
- plugin manager, agent bus, or prompt-cache wiring
- a task router on a plain `ReactiveAgent` (`SupervisorAgentConfig` already takes one)

If you only need messages, tools, provider, IDs, and a final result, stay with `ReactiveAgent.run()`. `authorizationGate`, `sandboxProvider`, `compactionConfig` and `resumeHandler` are accepted directly on `ReactiveAgentConfig` and `SupervisorAgentConfig`, and `checkpointStore` on `ReactiveAgentConfig` — all of them forwarded into `drainQuery` — so neither a policy gate, a sandbox, a compaction policy nor a custom HITL handler is a reason to drop below the high-level surface.

## 2. `ReactiveAgent.run()` vs `drainQuery()`

| Surface | Best for | Notable limits |
| --- | --- | --- |
| `ReactiveAgent.run()` | Standard app integrations and quickstarts | Does not expose the genuinely query-only runtime fields (`pluginManager`, `taskRouter`, `agentBus`, `contextCache`). `authorizationGate`, `sandboxProvider`, `compactionConfig`, `resumeHandler` and `checkpointStore` ARE on `ReactiveAgentConfig` and forwarded into `drainQuery` |
| `drainQuery()` | Low-level runtime control with a final `AgentRun` result | You supply more runtime wiring yourself |
| `query()` | Full async-generator control over every emitted event | You manage iteration over the generator directly |

## 3. Minimal `drainQuery()` Example

```ts
import {
  ProviderRegistry,
  ToolRegistry,
  ReadFileTool,
  LocalSandboxProvider,
  drainQuery,
  autoApproveHandler,
  generateProjectId,
  generateSessionId,
  generateTenantId,
  generateTopicId,
  getRootLogger,
} from '@namzu/sdk'
import { registerOpenAI } from '@namzu/openai'

registerOpenAI()

const { provider } = ProviderRegistry.create({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini',
})

const tools = new ToolRegistry()
tools.register(ReadFileTool)

const sandboxProvider = new LocalSandboxProvider(getRootLogger())

const run = await drainQuery(
  {
    provider,
    tools,
    agentId: 'docs-kernel-agent',
    agentName: 'Docs Kernel Agent',
    messages: [
      {
        role: 'user',
        content: 'Read package.json and tell me the package name.',
      },
    ],
    workingDirectory: process.cwd(),
    runConfig: {
      model: 'gpt-4o-mini',
      tokenBudget: 8_192,
      timeoutMs: 60_000,
      permissionMode: 'plan',
    },
    projectId: generateProjectId(),
    sessionId: generateSessionId(),
    topicId: generateTopicId(),
    tenantId: generateTenantId(),
    resumeHandler: autoApproveHandler,
    authorizationGate: {
      enabled: true,
      allowReadOnlyTools: true,
      denyDangerousPatterns: true,
      logDecisions: true,
      rules: [{ type: 'allow_by_category', categories: ['filesystem'] }],
    },
    sandboxProvider,
  },
  async (event) => {
    console.log(event.type)
  },
)

console.log(run.result)
```

This example shows the main low-level boundary:

- `runConfig` still carries model, budget, and permission settings
- query-only fields such as `pluginManager`, `agentBus`, and `contextCache` live beside that config; `authorizationGate` and `sandboxProvider` are accepted here but are *also* exposed on `ReactiveAgentConfig` and `SupervisorAgentConfig`, so dropping to `drainQuery` is not required just to enable a policy gate or hand the run a sandbox
- `drainQuery()` still returns the same final `AgentRun` shape that high-level agent flows assemble

## 4. What `drainQuery()` Gives You

`drainQuery()` is the convenience wrapper around `query()`:

- it consumes the async generator for you
- it forwards every `RunEvent` to an optional listener
- it returns the final `AgentRun`
- it falls back to `autoApproveHandler` if you omit `resumeHandler`

That makes it the best low-level entrypoint when you still want one final result object.

## 5. Use `query()` for Generator-Level Control

If you need full control over the event stream, use `query()` directly:

```ts
import {
  query,
  mapRunToStreamEvent,
  autoApproveHandler,
  generateProjectId,
  generateSessionId,
  generateTenantId,
  generateTopicId,
} from '@namzu/sdk'
import type { LLMProvider, ToolRegistry } from '@namzu/sdk'

// Built exactly as in the `drainQuery()` example above.
declare const provider: LLMProvider
declare const tools: ToolRegistry

const iterator = query({
  provider,
  tools,
  agentId: 'docs-kernel-agent',
  agentName: 'Docs Kernel Agent',
  messages: [{ role: 'user', content: 'Say hello.' }],
  workingDirectory: process.cwd(),
  runConfig: {
    model: 'gpt-4o-mini',
    tokenBudget: 8_192,
    timeoutMs: 60_000,
  },
  projectId: generateProjectId(),
  sessionId: generateSessionId(),
  topicId: generateTopicId(),
  tenantId: generateTenantId(),
  resumeHandler: autoApproveHandler,
})

while (true) {
  const next = await iterator.next()

  if (next.done) {
    console.log(next.value.result)
    break
  }

  const event = next.value
  const mapped = mapRunToStreamEvent(event, event.runId)
  if (mapped) {
    console.log(mapped.wire, mapped.data)
  }
}
```

Use this pattern when a transport layer or UI needs every incremental event as it happens.

## 6. Query-Only Fields You Do Not Get Through `ReactiveAgent.run()`

`QueryParams` exposes extra runtime controls that are not currently surfaced on `ReactiveAgentConfig`:

| Field | Purpose |
| --- | --- |
| `pluginManager` | Run plugin hooks and plugin-contributed runtime behavior |
| `taskRouter` | Task-specific model routing (`SupervisorAgentConfig` takes one too; `ReactiveAgentConfig` does not) |
| `agentBus` | Concurrency coordination and lock-style runtime controls |
| `contextCache` | Prompt cache and context reuse controls |

That is the main reason this page exists: these are real public runtime features, but they are lower-level than the first-run agent API.

`authorizationGate`, `sandboxProvider`, `compactionConfig` and `resumeHandler` are intentionally **not** in this table — each is exposed on both `ReactiveAgentConfig` and `SupervisorAgentConfig` and forwarded into `drainQuery` automatically. They still appear in the `drainQuery()` example above because the low-level surface accepts them too; just don't read that as "you have to drop here to use them."

## 7. Resume Handlers and HITL

Low-level runtime control is also where human-in-the-loop policy becomes explicit.

```ts
import type { ResumeHandler } from '@namzu/sdk'

const resumeHandler: ResumeHandler = async (request) => {
  switch (request.type) {
    case 'plan_approval':
      return { action: 'approve_plan' }
    case 'tool_review':
      return { action: 'approve_tools' }
    case 'iteration_checkpoint':
      return { action: 'continue' }
    case 'user_question':
      return {
        action: 'answer_question',
        selectedOptionIds: [],
        freeText: 'No user is available to answer. Proceed using your best judgment.',
        questionId: request.question.questionId,
      }
  }
}
```

`HITLDecisionRequest` has four members, and a `ResumeHandler` owes an answer to
every one of them — `user_question`, the model asking the user something through
the same park, included. An empty `selectedOptionIds` is how a headless handler
declines without fabricating a choice, and echoing `request.question.questionId`
back stops a late answer from being applied to the question that replaced it.

Use `autoApproveHandler` only when the runtime should continue automatically.

A `plan_approval` request carries the plan on `request.plan`, and each entry of
`request.plan.steps` names the agent it delegates to on `agentId` — absent means
the step is the orchestrator's own work. Approving "delegate this step" is not
the same as approving "delegate this step to the agent with shell access", so an
auto-approver that ignores the field is approving something it has not read.

> **`PlanApprovalData.steps[].agentId` is new in `@namzu/sdk` 12.2.0.** Earlier
> versions carried the field only on `PlanApprovalRequest`, the surface you get
> from installing your own handler on `PlanManager` — not on this one, which is
> the path a `resumeHandler` is served by.

The full plan lifecycle — approving, reporting each step, and settling — is in
[Plans and Step Reporting](./plans.md).

### Remembering an approval, at a scope you choose

An approval used to be recorded nowhere: approving emitted an event and
settled. `bash` is unconditionally non-read-only and in no read-only
allowlist, so `bash: git status` re-prompted on every batch forever — and
the only escape was a blanket session grant that also covered every
destructive call.

```ts
import { autoApproveHandler, toolGrantKeys } from '@namzu/sdk'
import type { ResumeHandler } from '@namzu/sdk'

const resumeHandler: ResumeHandler = async (request) => {
  switch (request.type) {
    case 'tool_review': {
      const call = request.toolCalls[0]
      const keys = toolGrantKeys(call)

      return {
        action: 'approve_tools',
        // This exact invocation, for the rest of the run:
        remember: [keys.call],
        // …or `[keys.tool]` for the whole tool, whatever the arguments.
      }
    }
    default:
      return autoApproveHandler(request)
  }
}
```

Every call in a later batch that is covered by a recorded grant skips the
park entirely. Three properties are load-bearing:

- **Nothing is remembered unless the decision says so.** A denial, a
  non-response, or an approval that omits `remember` leaves nothing behind.
  Non-reuse is still the default — what changed is that the *scope* is the
  approver's to choose.
- **Grants are run-scoped and not persisted.** An approval is a statement
  about this run's work; carrying it into a later run would be reuse nobody
  agreed to. The checkpointed decision remains as evidence of what was
  approved, not as a standing permission.
- **Argument key order does not matter.** `{path, mode}` and `{mode, path}`
  produce the same grant key, so the same call is not asked about twice —
  which is how an approver learns to grant the wide key instead.

### Giving a park a deadline

`runConfig.hitlParkTtlMs` writes an **absolute** deadline onto every park.
Without one, a run parks for approval, the worker is redeployed, nobody
answers, and the checkpoint stays outstanding forever — every
approval-queue reader keeps serving it and its workspace is never
reclaimed. The run timeout cannot cover this: it is only checked between
iterations and a park suspends mid-iteration, so a long-lived process
hard-stops the run immediately *after* the human finally approves, while
across a restart the restored elapsed clock excludes parked time entirely.

Expiry is enforced on read — `findPendingCheckpoint` skips an expired park
— and swept by the host:

```ts
import { listExpiredParks } from '@namzu/sdk'
import type { CheckpointManager, CheckpointRunScope, CheckpointStore } from '@namzu/sdk'

declare const store: CheckpointStore
declare const scope: CheckpointRunScope
declare const checkpointMgr: CheckpointManager

for (const stale of await listExpiredParks(store, scope)) {
  await checkpointMgr.expire(stale.id)
}
```

`expire` records the expiry rather than deleting it: a checkpoint showing
what was asked and that nobody answered in time is the evidence an approval
gate is worth having. The out-of-process timer stays a host concern,
consistent with the same decision made for retention.

`deriveRunStatus({ status, park })` projects a run plus its park onto the
session-layer `RunStatus`, and is what finally produces
`awaiting_hitl_resolution` — a variant that has documented a "persisted
wait after a HITL timeout" since it was declared, for a timeout nothing
could raise.

## 8. Verification and Sandbox Boundaries

Two runtime fields are easy to confuse:

| Field | Role | Where exposed |
| --- | --- | --- |
| `authorizationGate` | Decide whether a tool call should proceed | `ReactiveAgentConfig`, `SupervisorAgentConfig`, and `QueryParams` |
| `sandboxProvider` | Constrain what sandbox-aware tools can do if the call proceeds | `ReactiveAgentConfig`, `SupervisorAgentConfig`, and `QueryParams` |

This separation matters operationally:

- authorization is policy
- sandboxing is containment

They are two different questions, not two different layers: both are wired through agent config, so either one is a one-line addition and neither is a reason to drop to `query()` / `drainQuery()`. Nothing propagates a sandbox for you — a multi-agent host that wants one ephemeral container per task threads the *same* provider instance into the supervisor's `sandboxProvider` and into every child `ReactiveAgentConfig.sandboxProvider` itself.

## 9. Event Streaming and SSE Mapping

`query()` and `drainQuery()` emit normalized `RunEvent` values. If you need a wire-friendly event shape, use `mapRunToStreamEvent(event, runId)`.

Important nuance:

- many incremental runtime events map cleanly to wire events
- final completion still comes from the async generator return value or the `drainQuery()` result

That means stream transport code usually needs both:

1. mapped incremental events during execution
2. the final `AgentRun` when execution completes

Provider failures carry an additional safe, serializable classification:

```ts
import { drainQuery } from '@namzu/sdk'
import type { QueryParams } from '@namzu/sdk'

declare const params: QueryParams

const run = await drainQuery(params, async (event) => {
  if (event.type === 'run_failed' && event.providerError) {
    console.error({
      kind: event.providerError.kind,
      providerId: event.providerError.providerId,
      status: event.providerError.status,
      retryAfterMs: event.providerError.retryAfterMs,
    })
  }
})

if (run.lastProviderError?.kind === 'throttle') {
  // A scheduler can use retryAfterMs without parsing an error message.
}
```

`providerError` and `lastProviderError` are present only when the failure came
from a provider as a classified `ProviderRequestError`. Other runtime failures
continue to use the ordinary `error` / `lastError` fields.

The metadata never includes a raw response body, URL, or error `cause`. It does
carry `detail` — what the provider itself said was wrong, truncated to 400
characters with anything credential-shaped replaced by `[redacted]`. That field
usually names the exact rejected parameter, so a failure UI can show the cause
without parsing the message string:

```ts
import type { AgentRun } from '@namzu/sdk'

declare const run: AgentRun

if (run.lastProviderError?.kind === 'bad_request') {
  console.error(run.lastProviderError.detail)
  // e.g. "tools.0.custom.input_schema: JSON schema is invalid. …"
}
```

> **Changed in `@namzu/sdk` 6.0.0.** `detail` was previously absent from this
> metadata and always `undefined` on the error itself.

## 10. Common Mistakes

| Mistake | Why it breaks |
| --- | --- |
| assuming `ReactiveAgent.run()` exposes every runtime field | query-only controls such as `pluginManager`, `agentBus`, and `contextCache` are lower-level (note: `authorizationGate`, `sandboxProvider`, `compactionConfig` and `resumeHandler` ARE on `ReactiveAgentConfig`) |
| forgetting `resumeHandler` when calling `query()` | `query()` requires it directly, unlike `drainQuery()` |
| skipping `workingDirectory` | filesystem tools and path layout lose their stable base path |
| treating `mapRunToStreamEvent()` as the final result channel | completion still comes from generator completion or `drainQuery()` |

## Related

- [SDK Quickstart](../quickstart.md)
- [Run Configuration](./configuration.md)
- [Tool Safety](../tools/safety.md)
- [Connectors and MCP](../integrations/connectors-and-mcp.md)
- [Plugins and MCP Servers](../integrations/plugins.md)
- [Event Bridges](../integrations/event-bridges.md)
- [Query Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/runtime/query/index.ts)
- [Run Event Types](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/types/run/events.ts)
