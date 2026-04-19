---
title: Foundation Folders
description: Deep reference for the foundation layer of @namzu/sdk, including types, contracts, constants, config, utils, and versioning.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# Foundation Folders

The SDK's foundation layer is where the package defines its language before it defines behavior. These folders look quieter than `runtime/` or `session/`, but they are what make the rest of the architecture consistent.

## 1. Why the Foundation Layer Exists

The main design choice here is simple:

- shared vocabulary should exist before orchestration
- defaults should be centralized before runtime behavior depends on them
- utility concerns should be reusable without dragging in a domain subsystem

That is why the SDK keeps `types/`, `contracts/`, `constants/`, `config/`, `utils/`, and `version.ts` close to the root.

## 2. `types/`

`types/` is the internal vocabulary of the SDK. It is large on purpose because the package wants agent, provider, session, tool, connector, memory, and safety modules to speak the same language without importing each other's concrete implementations.

### 2.1 What It Organizes

| Domain group | Examples | Why it matters |
| --- | --- | --- |
| Core runtime | `agent/`, `run/`, `message/`, `decision/`, `task/`, `plan/` | Lets runtime, agents, managers, and stores share a common execution model |
| Integration surfaces | `provider/`, `connector/`, `tool/`, `plugin/`, `skills/`, `persona/`, `computer-use/` | Keeps extension contracts stable even when implementations move outside the SDK |
| State and memory | `session/`, `conversation/`, `memory/`, `activity/` | Makes persistence and lifecycle code depend on stable shapes |
| Safety and operations | `permission/`, `verification/`, `sandbox/`, `telemetry/`, `bus/`, `invocation/` | Keeps guardrail code composable instead of embedding policy ad hoc |
| Protocol and compatibility | `a2a/`, `router/`, `structured-output/`, `common/`, `ids/` | Supports public or cross-cutting boundaries without leaking implementation details |

### 2.2 Why `types/` Is So Broad

The SDK uses `types/` as a stabilizer:

- a provider implementation can change without changing `types/provider/`
- session persistence can change without redefining `types/session/`
- tool factories can evolve without rewriting `types/tool/`

This is one of the core reasons the package can expose a wide public API from a single barrel without every consumer binding to concrete classes.

## 3. `contracts/`

`contracts/` is the external-facing sibling of `types/`. It exists for shapes that should be read as wire or compatibility contracts rather than as internal domain language.

Why it is separate:

- internal runtime types do not have to become transport contracts
- compatibility-sensitive shapes can evolve independently from orchestration internals
- external consumers can target explicit contracts rather than reverse-engineering runtime classes

Use this folder when the shape is about public exchange, protocol semantics, or envelope compatibility. Use `types/` when the shape is about internal domain modeling.

## 4. `constants/`

`constants/` centralizes operational defaults and names by subsystem instead of keeping one giant mixed constants file.

### 4.1 Subfolder Map

| Constant area | What it groups |
| --- | --- |
| `a2a/` | Agent-to-agent protocol defaults and names |
| `advisory/` | Advisory thresholds, labels, or subsystem defaults |
| `agent/` | Agent-facing runtime defaults |
| `bus/` | Coordination and breaker-related defaults |
| `compaction/` | Context compaction thresholds and behavior values |
| `mcp/` | MCP protocol and transport defaults |
| `plugin/` | Plugin discovery or hook-related defaults |
| `provider/` | Provider-facing runtime defaults |
| `rag/` | Retrieval and chunking defaults |
| `sandbox/` | Sandbox guardrail defaults |
| `telemetry/` | Shared telemetry names and metric defaults |
| `tools/` | Tool-level names and defaults |
| `verification/` | Verification and review defaults |
| `emergency.ts` | Emergency-save behavior constants |
| `limits.ts` | Cross-runtime budget and limit constants |

### 4.2 Why This Split Matters

Constants are architecture, not decoration. Grouping them by domain means:

- runtime behavior stays inspectable
- changing a threshold has clear ownership
- new subsystems do not need to hide defaults inside implementation files

## 5. `config/`

`config/` owns runtime schema validation and the assembly of typed defaults.

Why it is separate:

- configuration is a boundary, not an implementation detail
- runtime startup should validate once and pass structured config inward
- packages using the SDK need one authoritative source for defaults such as compaction, plugins, sandboxing, and routing

This folder is what prevents lifecycle classes from each becoming their own mini config parser.

## 6. `utils/`

`utils/` contains reusable infrastructure helpers such as IDs, logging, hashing, error helpers, abort helpers, memoization, shell compression, and cost utilities.

Why it is separate:

- these helpers are cross-domain rather than domain-owned
- the same helper should not be reimplemented in `runtime/`, `tools/`, and `store/`
- keeping helpers small and isolated reduces architectural drift

The practical rule is:

- if it expresses domain ownership, it does not belong in `utils/`
- if it is reusable infrastructure with no domain home, it probably does

## 7. `version.ts`

`version.ts` gives the SDK a single exported version constant.

Why it exists:

- version strings should not be duplicated across runtime or transport layers
- public consumers sometimes need a runtime-visible package version
- observability or diagnostics can attach to one canonical value

## 8. Practical Placement Rules

When working in this layer:

1. Put a shape in `types/` if multiple subsystems need it internally.
2. Put a shape in `contracts/` if it is a wire or compatibility contract.
3. Put numeric or string defaults in `constants/` if they affect behavior.
4. Put schema validation and default assembly in `config/`.
5. Put reusable infrastructure helpers in `utils/`, but keep domain logic out.

## Related

- [SDK Architecture](./README.md)
- [Pattern Language](./pattern-language.md)
- [Source Tree](./source-tree.md)
- [Folder Reference](./folder-reference.md)
- [SDK Root Barrel](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/index.ts)
