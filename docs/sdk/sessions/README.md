---
title: Sessions, Workspaces, and Retention
description: Understand the project-session-sub-session model, session stores, workspaces, handoff, and archival surfaces exposed by @namzu/sdk.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# Sessions, Workspaces, and Retention

The SDK does not treat a run as the only stateful concept. It also exposes a tenant-scoped session hierarchy for durable work, delegation, workspaces, and archival. This is one of the most important internal patterns in Namzu, and it is intentionally public because orchestration code needs it directly.

## 1. The Entity Model

The public hierarchy is:

1. `Project`
2. `Session`
3. `SubSession`

Each level solves a different problem:

| Entity | Role |
| --- | --- |
| `Project` | long-lived scope for shared limits, knowledge bases, memory, and retention policy |
| `Session` | active work unit owned by one actor at a time |
| `SubSession` | delegation or intervention edge between a parent session and a child session |

Three identity rules are important:

- `tenantId` is the isolation boundary
- `projectId` is the long-lived goal scope
- `sessionId` is the concrete execution or collaboration unit

## 2. Start with a Session Store

The easiest way to understand the model is to create a project and session explicitly:

```ts
import {
  InMemorySessionStore,
  generateTenantId,
} from '@namzu/sdk'

const store = new InMemorySessionStore()
const tenantId = generateTenantId()

const project = await store.createProject(
  {
    tenantId,
    name: 'Docs Workspace',
  },
  tenantId,
)

const session = await store.createSession(
  {
    projectId: project.id,
    currentActor: null,
  },
  tenantId,
)

await store.appendMessage(
  session.id,
  { role: 'user', content: 'Document the public SDK.' },
  tenantId,
)

const drill = await store.drill(session.id, tenantId)

console.log(project.id)
console.log(session.id)
console.log(drill?.ancestry)
console.log(drill?.children)
```

This example demonstrates the core design:

- the store generates IDs
- every accessor takes `tenantId`
- messages are stored against a session, not a generic thread string

## 3. `InMemorySessionStore` vs `DiskSessionStore`

The two main public store implementations serve different needs:

| Store | Use it when |
| --- | --- |
| `InMemorySessionStore` | tests, local prototypes, ephemeral workers |
| `DiskSessionStore` | a local runtime needs durable filesystem-backed session state |

`DiskSessionStore` is filesystem-backed and intentionally conservative:

- writes are atomic
- project and session records live in a predictable directory tree
- tenant checks happen on record payloads, not path guessing
- missing resources return `null` or an empty collection rather than silent fallback

Minimal disk-backed setup:

```ts
import { DiskSessionStore } from '@namzu/sdk'
import { join } from 'node:path'

const store = new DiskSessionStore({
  rootDir: join(process.cwd(), '.namzu', 'state'),
})
```

## 4. Workspaces Are Adjacent to Sessions, Not the Same Thing

A session may reference a workspace, but session lifecycle and workspace lifecycle are deliberately separate.

Public workspace surfaces include:

- `WorkspaceBackendRegistry`
- `DefaultPathBuilder`
- `GitWorktreeDriver`

Use this split when:

- one session needs a workspace now, but another does not
- a workspace may be archived or torn down while the session record remains
- different workspace backends may exist under the same session model

## 5. Handoff Is an Explicit State Machine

The handoff API exists because ownership transfer is a real lifecycle event, not a vague status flag.

Main public handoff exports:

- `executeSingleHandoff()`
- `executeBroadcastHandoff()`
- `DefaultCapacityValidator`
- `HandoffVersionConflict`
- `HandoffLockRejected`

Use these when ownership needs to move safely between actors or when one parent session fans out to multiple child recipients.

Important design boundary:

- handoff primitives operate on session state and versioning
- they do not replace the higher-level agent loop

## 6. Summaries, Interventions, and Migration

The session surface also includes lifecycle helpers for long-running systems:

| Surface | Why it exists |
| --- | --- |
| `SessionSummaryMaterializer` | convert terminal child work into a stable summary reference |
| `validatePrevArtifactChain()` | prevent invalid intervention DAGs |
| `DefaultFilesystemMigrator` | migrate older on-disk layouts and legacy ID prefixes |

These are not "optional polish" APIs. They exist so orchestration code can evolve without losing structural guarantees.

## 7. Retention and Archival Are First-Class

Retention is public because session trees outlive individual runs.

Main exports:

- `ArchivalManager`
- `DiskArchiveBackend`
- `RETENTION_POLICY_DISABLED`
- archive-related error types

Use retention when:

- old sub-sessions should be sealed and removed from the active hot path
- you need explicit archive backend control
- a project's retention policy should govern long-tail state

The design intent is important:

- active execution state lives in the session and store surfaces
- archived state lives behind a retention backend
- the two are connected, but not collapsed into one mutable record

## 8. Common Mistakes

| Mistake | Why it hurts |
| --- | --- |
| treating `sessionId` as a disposable run ID | sessions are durable lifecycle objects, not just one provider call |
| deleting a session that still has attached sub-sessions | the store rejects this; callers must clean up children first |
| assuming tenant isolation is implied by file paths | tenant checks are explicit and enforced in the store contracts |
| using `threadId` as the canonical long-term identifier | `projectId` is the forward-looking identity; `threadId` is a migration-window alias |
| binding workspace lifetime directly to every session by default | the SDK keeps workspace provisioning explicit and separate |

## Related

- [Run Identities](../runtime/identities.md)
- [Agents and Orchestration](../agents/README.md)
- [Low-Level Runtime](../runtime/low-level.md)
- [Session and Store Folders](../architecture/session-and-store-folders.md)
- [State and Persistence](../architecture/state-and-persistence.md)
- [Session Barrel](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/session/index.ts)
- [Session Store Types](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/types/session/store.ts)
