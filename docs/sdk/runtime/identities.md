---
title: Run Identities
description: Required IDs for agent runs in @namzu/sdk, how to generate them, and how to decide when to reuse or rotate them.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# Run Identities

The SDK requires explicit runtime identities. This is not bookkeeping for its own sake; these IDs are what let the runtime keep session lineage, tenant isolation, persistence, and multi-run reasoning coherent.

## 1. The Three Required IDs

For `ReactiveAgent.run()` in current public runtime usage, these three fields matter most:

| Field | What it represents | Typical lifetime |
| --- | --- | --- |
| `projectId` | Long-lived goal or project scope | Reused across many sessions and runs |
| `sessionId` | One immediate working session inside a project | Reused across one interactive session or task burst |
| `tenantId` | Isolation boundary between organizations, users, or workspaces | Reused across all work for the same tenant |

If any of these is missing, `ReactiveAgent` throws before starting the run.

## 2. Why the SDK Requires Them

These IDs drive real behavior:

- `tenantId` protects isolation boundaries
- `projectId` gives the runtime a durable project scope
- `sessionId` groups immediate run activity under one active session

Without them, state and persistence would collapse into anonymous runs, which breaks session-aware architecture.

## 3. ID Helpers You Can Use Today

The SDK exports generator helpers so applications do not need to handcraft ID strings:

```ts
import {
  generateProjectId,
  generateSessionId,
  generateTenantId,
  generateRunId,
} from '@namzu/sdk'

const projectId = generateProjectId()
const sessionId = generateSessionId()
const tenantId = generateTenantId()
const runId = generateRunId()
```

## 4. Common ID Helpers

| Helper | Prefix emitted | Use it for |
| --- | --- | --- |
| `generateProjectId()` | `prj_` | Project scope |
| `generateSessionId()` | `ses_` | Session scope |
| `generateTenantId()` | `tnt_` | Tenant scope |
| `generateRunId()` | `run_` | Run records |
| `generateMessageId()` | `msg_` | Message records |
| `generateTaskId()` | `task_` | Task records |
| `generatePlanId()` | `plan_` | Plan records |
| `generateToolCallId()` | `call_` | Tool calls |

The runtime usually handles deeper IDs such as `runId` internally, but the helpers are public when your application needs them.

## 5. Reuse vs Regenerate

Use this rule of thumb:

- keep `tenantId` stable for one tenant
- keep `projectId` stable for one long-lived goal or project
- keep `sessionId` stable while a user is continuing the same active working session
- create a new `sessionId` when you intentionally start a fresh session under the same project

That means a typical application might map them like this:

| App concept | Namzu field |
| --- | --- |
| organization or workspace | `tenantId` |
| issue, project, repo task, or long-running assistant goal | `projectId` |
| current chat tab, active coding session, or temporary execution thread | `sessionId` |

## 6. Minimal Example

```ts
import {
  ReactiveAgent,
  ToolRegistry,
  generateProjectId,
  generateSessionId,
  generateTenantId,
} from '@namzu/sdk'

const agent = new ReactiveAgent({
  id: 'identity-demo',
  name: 'Identity Demo',
  version: '1.0.0',
  category: 'docs',
  description: 'Example for required run IDs.',
})

// Assume `provider` has already been created through ProviderRegistry.create(...).
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
    sessionId: generateSessionId(),
  },
)
```

## 7. Migration Note: `threadId`

You may still see references to `threadId` in code or migration comments. That exists only as a compatibility window:

- `projectId` is the current long-lived project scope
- `threadId` is deprecated

For new public integrations, use `projectId`, `sessionId`, and `tenantId`.

## 8. Common Mistakes

| Mistake | Why it causes trouble |
| --- | --- |
| generating a new `projectId` on every single message | breaks long-lived project grouping |
| reusing one `sessionId` forever | collapses separate active sessions into one lineage |
| using one `tenantId` for every user or customer | removes meaningful isolation boundaries |
| hardcoding raw strings without validation | makes ID drift and debugging harder |

## 9. App-Level Recommendation

If your application already has durable IDs, map them once and keep them stable:

- map your workspace or org ID to `tenantId`
- map your project or issue ID to `projectId`
- map your active chat/session UI instance to `sessionId`

Only use generator helpers when you do not already have a durable identity model.

## Related

- [SDK Quickstart](../quickstart.md)
- [Run Configuration](./configuration.md)
- [Provider Registry](../provider-integration/registry.md)
- [ID Utilities Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/utils/id.ts)
- [BaseAgentConfig Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/types/agent/base.ts)
