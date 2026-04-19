---
title: Source Tree
description: Folder-by-folder reference for packages/sdk/src and the architectural responsibilities of each module.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# Source Tree

The SDK source tree is broad, but it is not arbitrary. Each top-level folder has a fairly specific ownership boundary, and most of the package's complexity comes from how these folders compose rather than from any single file.

## 1. Top-Level Folder Map

This is the practical map of `packages/sdk/src`:

```text
advisory/    agents/      bridge/      bus/         compaction/
config/      connector/   constants/   contracts/   execution/
gateway/     manager/     persona/     plugin/      provider/
rag/         registry/    router/      run/         runtime/
sandbox/     session/     skills/      store/       telemetry/
tools/       types/       utils/       vault/       verification/
index.ts     version.ts
```

## 2. Foundation Layer

These folders define the static language of the SDK:

| Folder | Responsibility |
| --- | --- |
| `types/` | Canonical internal type contracts grouped by domain |
| `contracts/` | Wire-facing or shared contract shapes such as API and protocol-facing types |
| `constants/` | Centralized defaults and domain constants |
| `config/` | Runtime configuration schemas and defaults |
| `utils/` | Small cross-cutting helpers such as IDs, costs, logging, hashing, and abort helpers |
| `version.ts` | Single exported package version constant |

`types/` is especially important because many higher-level folders depend on it without needing to know about concrete implementations.

## 3. Execution Core

These folders own the active behavior of an agent run:

| Folder | Responsibility |
| --- | --- |
| `agents/` | Agent classes such as `ReactiveAgent`, `PipelineAgent`, `RouterAgent`, and `SupervisorAgent` |
| `runtime/` | Query construction, provider calls, iteration orchestration, tool review, compaction checks, and completion assembly |
| `compaction/` | Context reduction strategies, summary verification, and working-state serialization |
| `run/` | Limit checking and reporting helpers tied to run execution |
| `execution/` | Execution-context abstractions used by connector and runtime flows |
| `manager/` | Lifecycle orchestration for runs, plans, agents, and connectors |
| `registry/` | Static catalogs such as tools, agents, connectors, and plugins |
| `router/` | Task-model routing helpers such as `resolveTaskModel()` |

The usual dependency direction here is:

```text
registries -> managers -> runtime -> agents
```

That is not a strict import diagram for every file, but it is the mental model the package encourages.

## 4. State and Durability

These folders own mutable data and long-lived project state:

| Folder | Responsibility |
| --- | --- |
| `session/` | Tenant-project-session hierarchy, workspaces, handoff, summaries, migration, retention, and intervention rules |
| `store/` | Run, task, conversation, memory, and activity storage implementations |
| `gateway/` | Local task gateway integration points used by the runtime |

This split matters:

- `session/` owns structure and rules.
- `store/` owns persistence implementations.
- `manager/` coordinates lifecycle around both.

## 5. Extension Surfaces

These folders let the SDK attach to outside systems or alternative behaviors:

| Folder | Responsibility |
| --- | --- |
| `provider/` | Provider registry and mock provider support |
| `connector/` | Connector base types, built-in connectors, MCP client or server support, and execution contexts |
| `bridge/` | Translation layers between internal runtime types and external protocols |
| `plugin/` | Plugin discovery, lifecycle, and resolution |
| `persona/` | Persona assembly and merge helpers |
| `skills/` | Skill discovery, loading, and chain resolution |
| `rag/` | Chunking, embeddings, vector store, retriever, knowledge base, and RAG tool generation |
| `advisory/` | Advisor registry, trigger evaluation, and advisory execution |
| `tools/` | Tool factories and built-in tool implementations |

## 6. Safety and Operations

These folders exist to keep runs safe, observable, and operationally coherent:

| Folder | Responsibility |
| --- | --- |
| `sandbox/` | Sandbox provider factory and local sandbox implementation |
| `verification/` | Verification gate and rule evaluation |
| `bus/` | Locking, ownership tracking, and breaker-style coordination for concurrent runs |
| `telemetry/` | Shared telemetry attribute and metric helpers |
| `vault/` | Credential storage abstractions and in-memory implementation |

## 7. Where New Code Usually Goes

Use this as a practical ownership guide before adding a new file:

| If you are adding... | Put it in... | Reason |
| --- | --- | --- |
| A new stable domain type | `types/<domain>/` | Types remain reusable and implementation-neutral |
| A new static catalog | `registry/<domain>/` | Registries own definitions, not live lifecycle |
| A new lifecycle coordinator | `manager/<domain>/` | Managers own runtime behavior and transitions |
| A new context reduction strategy | `compaction/` | Compaction is a dedicated subsystem, not a runtime helper |
| A new persisted mutable store | `store/<domain>/` | Store implementations stay separate from orchestration |
| A new tool or tool factory | `tools/<domain>/` or `tools/builtins/` | Tool assembly belongs at the tool boundary |
| A new protocol adapter | `bridge/<protocol>/` or `connector/mcp/` | Bridge modules translate between internal and external shapes |
| A new safety control | `sandbox/`, `verification/`, or `bus/` | These folders own containment and coordination concerns |

## 8. Barrel Strategy

The SDK relies heavily on barrel exports:

- Folder-level `index.ts` files define public sub-surfaces.
- `packages/sdk/src/index.ts` is the package barrel and the user-facing entry point.
- Public docs should describe the package surface through the barrel, even when architecture docs explain the underlying folder layout.

## Related

- [SDK Architecture](./README.md)
- [Foundation Folders](./foundation-folders.md)
- [Execution Folders](./execution-folders.md)
- [Session and Store Folders](./session-and-store-folders.md)
- [Integration Folders](./integration-folders.md)
- [Runtime Pipeline](./runtime-pipeline.md)
- [State and Persistence](./state-and-persistence.md)
- [Extensions and Integrations](./extensions.md)
- [SDK Root Barrel](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/index.ts)
