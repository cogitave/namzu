---
title: State and Persistence
description: How @namzu/sdk models sessions, stores, checkpoints, tasks, memory, and durable run state.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# State and Persistence

The SDK's state model is spread across `session/`, `store/`, and parts of `manager/`. The distinction is deliberate: `session/` defines structural rules, `store/` provides persistence implementations, and `manager/` coordinates runtime behavior around both.

## 1. Session Hierarchy

The `session/` folder is not a single data type. It is a grouped subsystem with several submodules:

| Folder | Responsibility |
| --- | --- |
| `hierarchy/` | Core tenant, project, session, and sub-session entities plus status derivation |
| `workspace/` | Workspace references, path building, and workspace backend drivers |
| `handoff/` | Single and broadcast handoff flows plus capacity and version checks |
| `summary/` | Session summary references and summary materialization |
| `intervention/` | Validation for `prevArtifactRef` chains and intervention depth |
| `migration/` | Filesystem and ID-prefix migration helpers |
| `retention/` | Archival policies, archive backends, and tombstone flow |
| `events/` | Session-level event shapes |

This makes `session/` one of the deepest architecture folders in the package.

## 2. Workspace Ownership

`session/workspace/` defines how session-scoped workspaces are represented and created:

- `PathBuilder` and `DefaultPathBuilder` define path conventions.
- `WorkspaceBackendRegistry` resolves workspace backend implementations.
- `GitWorktreeDriver` is the concrete driver for git-worktree-based isolation.

This is an example of a subsystem that keeps its contract and driver in the same domain folder, because both are session-owned concerns.

## 3. Store Layer

`store/` holds concrete persistence implementations:

| Store area | Main implementation examples |
| --- | --- |
| Run storage | `store/run/disk.ts` |
| Task storage | `store/task/memory.ts`, `store/task/disk.ts` |
| Memory storage | `store/memory/index.ts`, `store/memory/memory.ts`, `store/memory/disk.ts` |
| Conversation compatibility | `store/conversation/memory.ts` |
| Activity storage | `store/activity/memory.ts` |

The important pattern is that stores persist or retrieve data, but they do not own broader runtime orchestration.

## 4. Run Persistence

`store/run/disk.ts` and `manager/run/persistence.ts` work together:

- `RunDiskStore` creates per-run directories and writes `run.json`, `messages.json`, `transcript.jsonl`, reports, and checkpoints.
- `RunPersistence` coordinates the runtime-facing state transitions around that disk layer.

The disk layout is intentionally file-oriented and append-friendly rather than database-first.

## 5. Task Storage

`DiskTaskStore` is a good example of the SDK's persistence style:

- Paths are derived from `baseDir`, `runId`, and optional `tenantId`.
- Writes are atomic through temp-file-and-rename behavior.
- Related task edges are updated while holding per-task locks.
- Event listeners receive structured task events after mutations.

This is not just a JSON dump helper. It already encodes concurrency and cascade-cleanup rules.

## 6. Memory Storage

The memory subsystem is split between index and content:

| Piece | Responsibility |
| --- | --- |
| `InMemoryMemoryIndex` | Searchable metadata index over memory entries |
| `DiskMemoryStore` | Durable content storage plus persistent index writes |
| `InMemoryMemoryStore` | Simpler in-memory content storage |

This lets search stay cheap while full content remains separately addressable.

## 7. Migration and Compatibility

The SDK still carries some migration-window compatibility surfaces:

- `store/conversation/memory.ts` is explicitly deprecated in favor of newer session-scoped storage.
- `session/migration/` handles filesystem migration and legacy ID acceptance.
- Runtime bootstrap calls migration before building the active run context.

The architecture implication is that compatibility is isolated in dedicated folders instead of leaking into the main runtime path.

## 8. Archival and Retention

`session/retention/` owns the long-tail lifecycle after active execution:

- retention policy types
- archive backends
- archival manager
- archive lookup and tombstone semantics

This keeps "what happens after a session becomes inactive" outside the hot path of the iteration loop.

## Related

- [SDK Architecture](./README.md)
- [Runtime Pipeline](./runtime-pipeline.md)
- [Extensions and Integrations](./extensions.md)
- [Session Barrel](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/session/index.ts)
- [RunDiskStore](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/store/run/disk.ts)
