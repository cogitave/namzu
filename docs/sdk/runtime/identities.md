---
title: Run Identities
description: Required IDs for agent runs in @namzu/sdk, how to generate them, and how to decide when to reuse or rotate them.
last_updated: 2026-08-07
status: current
related_packages: ["@namzu/sdk"]
---

# Run Identities

The SDK requires explicit runtime identities. This is not bookkeeping for its own sake; these IDs are what let the runtime keep the five-layer hierarchy, tenant isolation, persistence, and multi-run reasoning coherent.

## 1. The Four Required IDs

For `ReactiveAgent.run()` and the kernel spawn path, four fields matter most:

| Field | What it represents | Typical lifetime |
| --- | --- | --- |
| `tenantId` | Isolation boundary between organizations, users, or workspaces | Reused across all work for the same tenant |
| `projectId` | Long-lived folder-bound goal scope | Reused across many threads, sessions, and runs |
| `topicId` | Topic- or objective-level grouping key | Reused across many sessions for one line-of-work |
| `sessionId` | One immediate working session inside a thread | Reused across one interactive session or task burst |

If any of these is missing, the runtime throws before starting the run.

## 2. Why the SDK Requires Them

These IDs drive real behavior:

- `tenantId` protects isolation boundaries
- `projectId` gives the runtime a durable project scope, bound to a folder in local mode
- `topicId` groups many sessions under one line-of-work. It is **not** what an A2A connection attaches to — that is `projectId` (see [A2A Context](../sessions/a2a-threading.md))
- `sessionId` groups immediate run activity under one active session

Without them, state and persistence would collapse into anonymous runs, which breaks the hierarchy-aware architecture.

## 3. ID Helpers You Can Use Today

The SDK exports generator helpers so applications do not need to handcraft ID strings:

```ts
import {
  generateProjectId,
  generateTopicId,
  generateSessionId,
  generateTenantId,
  generateRunId,
} from '@namzu/sdk'

const tenantId = generateTenantId()
const projectId = generateProjectId()
const topicId = generateTopicId()
const sessionId = generateSessionId()
const runId = generateRunId()
```

## 4. Common ID Helpers

| Helper | Prefix emitted | Use it for |
| --- | --- | --- |
| `generateTenantId()` | `tnt_` | Tenant scope |
| `generateProjectId()` | `prj_` | Project scope (folder-bound) |
| `generateTopicId()` | `top_` | Topic scope (objective/line-of-work) |
| `generateSessionId()` | `ses_` | Session scope |
| `generateRunId()` | `run_` | Run records |
| `generateMessageId()` | `msg_` | Message records |
| `generateTaskId()` | `task_` | Task records |
| `generatePlanId()` | `plan_` | Plan records |
| `generateToolCallId()` | `call_` | Tool calls |

The runtime usually handles deeper IDs such as `runId` internally, but the helpers are public when your application needs them.

## 5. Reuse vs Regenerate

Use this rule of thumb:

- keep `tenantId` stable for one tenant
- keep `projectId` stable for one folder-bound goal or repository
- keep `topicId` stable while working on the same topic or objective
- keep `sessionId` stable while a user is continuing the same active working session
- create a new `topicId` when the topic changes (new objective, new line-of-work)
- create a new `sessionId` when you intentionally start a fresh session under the same thread

A typical application maps them like this:

| App concept | Namzu field |
| --- | --- |
| organization or workspace | `tenantId` |
| repository, workspace folder, long-running assistant goal | `projectId` |
| issue, ticket, objective, line-of-work | `topicId` |
| current chat tab, active coding session, temporary execution thread | `sessionId` |

## 6. Minimal Example

```ts
import {
  ReactiveAgent,
  ToolRegistry,
  generateProjectId,
  generateSessionId,
  generateTenantId,
  generateTopicId,
  type LLMProvider,
} from '@namzu/sdk'

const agent = new ReactiveAgent({
  id: 'identity-demo',
  name: 'Identity Demo',
  version: '1.0.0',
  category: 'docs',
  description: 'Example for required run IDs.',
})

// Created through ProviderRegistry.create(...) — see ../providers.
declare const provider: LLMProvider

const result = await agent.run(
  {
    messages: [{ role: 'user', content: 'Summarize what these IDs mean.' }],
    workingDirectory: process.cwd(),
  },
  {
    provider,
    tools: new ToolRegistry(),
    model: 'gpt-4o-mini',
    tokenBudget: 8_192,
    timeoutMs: 60_000,
    tenantId: generateTenantId(),
    projectId: generateProjectId(),
    topicId: generateTopicId(),
    sessionId: generateSessionId(),
  },
)
```

## 7. What Thread Is For

A Thread layer is not universal: a runtime without one collapses Project and Thread into a single identity.

This section used to say Namzu separates them because "the Thread is where A2A connections attach", and cited [A2A Context](../sessions/a2a-threading.md) as the rationale. **That page retracts exactly that claim.** The A2A bridge binds to `project_id` in both directions and has never referenced a Thread — pinned by `bridge/a2a/__tests__/project-is-the-a2a-context.test.ts`. A page cannot cite as its authority a document that contradicts it, so the justification is withdrawn rather than reworded.

What remains true is smaller and worth stating plainly:

- **Project** is folder-bound, and it is the A2A sharing boundary. A peer holding a `contextId` holds a Project.
- **Thread** is a path-independent grouping key over sessions. It owns no message stream, no status, no participant set and no directory of its own.

So use `topicId` when you want to group sessions by topic or objective and query them back. Do not reach for it as an isolation or sharing boundary — it is not one. If one peer should see part of a workspace and not the rest, give it a separate Project.

The layer's future is under discussion; see section 4 of [A2A Context](../sessions/a2a-threading.md). Nothing has been deprecated, and a "default" thread per project remains fine.

## 8. Common Mistakes

| Mistake | Why it causes trouble |
| --- | --- |
| generating a new `projectId` on every single message | breaks long-lived project grouping |
| reusing one `sessionId` forever | collapses separate active sessions into one lineage |
| using one `tenantId` for every user or customer | removes meaningful isolation boundaries |
| treating `topicId` as disposable or optional | loses the topic-level grouping you would otherwise query back |
| expecting `topicId` to scope what an A2A peer can see | it does not — `projectId` is the A2A boundary |
| hardcoding raw strings without validation | makes ID drift and debugging harder |

## 9. App-Level Recommendation

If your application already has durable IDs, map them once and keep them stable:

- map your workspace or org ID to `tenantId`
- map your repository or folder ID to `projectId`
- map your issue, ticket, or objective ID to `topicId`
- map your active chat/session UI instance to `sessionId`

Only use generator helpers when you do not already have a durable identity model.

## Related

- [SDK Quickstart](../quickstart.md)
- [A2A Context](../sessions/a2a-threading.md)
- [Run Configuration](./configuration.md)
- [Provider Registry](../provider-integration/registry.md)
- [ID Utilities Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/utils/id.ts)
- [BaseAgentConfig Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/types/agent/base.ts)
