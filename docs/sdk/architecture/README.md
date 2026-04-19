---
title: SDK Architecture
description: Deep architectural reference for the @namzu/sdk source tree, runtime pipeline, state model, and extension surfaces.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# SDK Architecture

This section documents `@namzu/sdk` as an implementation architecture, not just as a package API. It maps the public package surface back to the real `packages/sdk/src` folder structure so the documentation stays useful both for integrators and for contributors navigating the codebase.

## 1. Architectural Shape

At a high level, the SDK is organized around a small set of repeated patterns:

| Pattern | What it owns |
| --- | --- |
| Types and contracts | Stable cross-module shapes in `types/` and `contracts/` |
| Registries | Static definitions and catalogs in `registry/` |
| Managers | Lifecycle and orchestration in `manager/` |
| Stores | Mutable state and persistence in `store/` |
| Runtime | Query assembly, iteration flow, and final result shaping in `runtime/` |
| Compaction | Context reduction strategies and verified summarization in `compaction/` |
| Bridges | Protocol and subsystem translation in `bridge/` |
| Extensions | Providers, connectors, plugins, personas, skills, and RAG |

The result is a layered package where runtime orchestration stays inside the SDK while vendor- or environment-specific implementations stay outside or behind explicit interfaces.

## 2. Reading Order

If you are new to the SDK internals, read these pages in order:

1. [Pattern Language](./pattern-language.md) for the core structural rules.
2. [Source Tree](./source-tree.md) for the top-level module map.
3. [Folder Reference](./folder-reference.md) for the "why does this folder exist?" overview.
4. [Foundation Folders](./foundation-folders.md) for `types/`, `contracts/`, `constants/`, `config/`, `utils/`, and `version.ts`.
5. [Execution Folders](./execution-folders.md) for `agents/`, `runtime/`, `compaction/`, `manager/`, `registry/`, and routing.
6. [Session and Store Folders](./session-and-store-folders.md) for `session/`, `store/`, and `gateway/`.
7. [Integration Folders](./integration-folders.md) for `provider/`, `connector/`, `bridge/`, `tools/`, `plugin/`, `persona/`, `skills/`, `rag/`, and `advisory/`.
8. [Runtime Pipeline](./runtime-pipeline.md) for the execution path of a run.
9. [State and Persistence](./state-and-persistence.md) for sessions, stores, checkpoints, and disk layout.
10. [Extensions and Integrations](./extensions.md) for extension surfaces in runtime context.
11. [Safety and Operations](./safety.md) for sandboxing, verification, bus coordination, and operational guardrails.

## 3. Top-Level Dependency View

The SDK's internal folders are easiest to read in this dependency-oriented grouping:

```text
Foundation
  config/ constants/ contracts/ types/ utils/ version.ts

Execution Core
  agents/ runtime/ compaction/ run/ execution/ manager/ registry/

State and Durability
  session/ store/ gateway/

Extension Surfaces
  provider/ connector/ bridge/ plugin/ persona/ skills/ rag/ advisory/ tools/

Safety and Operations
  sandbox/ verification/ bus/ telemetry/ vault/
```

## 4. What This Section Optimizes For

These pages are written to answer questions such as:

- Which folder should own a new runtime concern?
- Where does a static definition stop and a lifecycle manager start?
- How does a request move from `ReactiveAgent.run()` into the iteration loop?
- Why does `compaction/` exist as its own subsystem instead of being hidden in `runtime/`?
- Which modules are public-facing contracts versus internal adapters?
- Where do persistence, safety, and extension mechanisms connect?

## Related

- [SDK Overview](../README.md)
- [Pattern Language](./pattern-language.md)
- [Folder Reference](./folder-reference.md)
- [Foundation Folders](./foundation-folders.md)
- [Execution Folders](./execution-folders.md)
- [Session and Store Folders](./session-and-store-folders.md)
- [Integration Folders](./integration-folders.md)
- [SDK Runtime](../runtime/README.md)
- [Source Tree](./source-tree.md)
- [Runtime Pipeline](./runtime-pipeline.md)
- [SDK Package Entry](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/index.ts)
