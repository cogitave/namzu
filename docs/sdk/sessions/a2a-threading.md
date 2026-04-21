---
title: A2A Threading
description: How the Project/Thread split supports enterprise sharing and agent-to-agent (A2A) connection in @namzu/sdk.
last_updated: 2026-04-21
status: current
related_packages: ["@namzu/sdk"]
---

# A2A Threading

Namzu's five-layer hierarchy (`Project → Thread → Session → SubSession → Run`) exists for a specific reason most agent frameworks do not have: **A2A connections attach at the Thread level, not the Project level**. This page explains why the Thread layer is first-class and how to use it.

## 1. The Sharing Model

- **A Project is folder-bound.** In local mode, a Project is scaffolded inside a directory (`.namzu/project.json`). Sharing a Project means sharing that directory — a repository, a workspace, or a remote workspace URL. Everyone with Project access can see its shape, its shared memory, its retention policy, and its Threads.
- **A Thread is the topic-level container.** Threads are path-independent. A single Project can contain many Threads — one per objective, issue, or line-of-work (e.g. `auth-refactor`, `billing-incident`). Threads can be partitioned by device, user, or agent identity.
- **A Session is one working interval** under a Thread, owned by one actor at a time.

The Thread layer is the thing Namzu adds that is missing in most frameworks (OpenAI's Responses API, LangGraph, Temporal, Microsoft Agent Framework, Claude Agent SDK). It exists because A2A needs a connection surface that is **not** the folder and **not** an individual work interval.

## 2. Why Thread and Not Project?

Projects are the coarse grouping unit. A team might share one Project across many unrelated lines-of-work. Attaching agents at the Project level would either:

- expose every Thread to every connected agent (too broad), or
- require per-thread permissioning inside the Project model (collapsing a natural boundary).

Attaching agents at the Thread level gives a **natural scope for delegation, monitoring, and hand-off**. Connecting to a Thread is "I want to help with the auth refactor," not "I want to work on this repo."

## 3. Why Thread and Not Session?

Sessions are specific, short-lived intervals with a single current actor. A2A connections need to survive across multiple sessions — a collaborator or agent comes and goes, resumes, reviews past work. The Thread layer is what keeps that continuity.

When a Thread is opened to an external agent, the agent can:

- enumerate the Sessions under the Thread
- join a Session as a new actor via `executeSingleHandoff` or `executeBroadcastHandoff`
- spawn new Sessions under the Thread (within depth and fan-out limits set at the Project level)
- emit and consume Run events stamped with Thread lineage

## 4. Boundaries the Thread Enforces

A Thread is a **container**, not a work unit. Specifically:

- A Thread has no message stream of its own. Messages live in Sessions.
- A Thread has no Run stream of its own. Runs live under Sessions.
- A Thread has no fan-in status derivation. Its `status` is `'open' | 'archived'` and owner-managed. (Contrast: Session status fans in from its Runs.)
- Thread archival requires every Session under the Thread to be in a terminal state (`idle`, `failed`, or `archived`). `ThreadManager.archive` enforces this precondition.

## 5. Minimal Enterprise-Sharing Flow

```ts
import {
  InMemorySessionStore,
  InMemoryThreadStore,
  ThreadManager,
  generateTenantId,
} from '@namzu/sdk'

const sessionStore = new InMemorySessionStore()
const threadStore = new InMemoryThreadStore()
const threadManager = new ThreadManager({ sessionStore, threadStore })
const tenantId = generateTenantId()

// Step 1: one Project shared by the team.
const project = await sessionStore.createProject(
  { tenantId, name: 'Enterprise Workspace' },
  tenantId,
)

// Step 2: multiple Threads under it — one per objective.
const authThread = await threadStore.createThread(
  { projectId: project.id, title: 'Auth refactor' },
  tenantId,
)
const billingThread = await threadStore.createThread(
  { projectId: project.id, title: 'Billing incident' },
  tenantId,
)

// Step 3: any agent connecting to `authThread.id` enumerates its Sessions
//         without seeing the billing work at all.
const authSessions = await sessionStore.listSessions(authThread.id, tenantId)

// Step 4: agents join by creating Sessions under the Thread, or by handing
//         off into existing ones. The Project and Thread stay the reference
//         frame for the whole collaboration.
```

## 6. Archive Discipline

When a Thread is archived via `ThreadManager.archive`:

1. It verifies **no Session under the Thread is in a non-terminal state**. Rejects with `ThreadNotEmptyError` if any Session is `active`, `locked`, `awaiting_hitl`, or `awaiting_merge`.
2. Flips the Thread to `status: 'archived'`. The record stays navigable — archived Threads continue to expose their Sessions for drill-down and audit.
3. New Session creation under the archived Thread is rejected via `ThreadClosedError`. Existing Sessions continue to receive Runs until they terminalize, at which point the Thread becomes fully inert.

This is why a Thread is not just a label — its state is load-bearing for archival discipline.

## 7. When Not to Use Thread

If your application has no A2A component, no multi-user sharing, and no multi-objective workflows under one Project, the Thread layer is still there but you will rarely touch it directly. In that case:

- create one "default" Thread per Project at bootstrap
- route all Sessions under that one Thread
- the model still works; the Thread layer is just a formality

The cost is small (one extra ID, one extra `createThread` call at bootstrap) and the benefit is that you never need to retrofit the Thread layer later when you do need A2A.

## Related

- [Sessions, Threads, Workspaces, and Retention](./README.md) — the full hierarchy overview.
- [Run Identities](../runtime/identities.md) — how the four required IDs (`tenantId`, `projectId`, `threadId`, `sessionId`) fit together at runtime.
- [Session and Store Folders](../architecture/session-and-store-folders.md) — where each piece lives in the SDK source.
