---
title: Pattern Language
description: Core architectural patterns used across @namzu/sdk and the reasoning behind the main folder boundaries.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# Pattern Language

The SDK source tree makes more sense when you read it as a pattern language rather than as a pile of folders. The most important thing for contributors is not memorizing file names, but understanding why certain concerns were split apart and why similar structures repeat across the package.

## 1. Types Before Implementations

One of the strongest recurring choices in the SDK is that domain shapes live in `types/` before they live in concrete modules.

Why this exists:

- it keeps cross-module contracts stable
- it reduces accidental coupling to concrete classes
- it makes public export surfaces easier to reason about
- it gives provider, connector, tool, and session features a common language

This is why `types/provider/`, `types/tool/`, `types/session/`, and `types/run/` are large. The architecture prefers shared vocabulary first and implementations second.

## 2. Contracts vs Types

`contracts/` and `types/` are intentionally not the same thing.

| Folder | Why it exists |
| --- | --- |
| `types/` | Domain-oriented TypeScript shapes used inside the SDK |
| `contracts/` | Wire-facing or protocol-facing shapes that external systems can depend on |

This split prevents the internal domain model from becoming the accidental public HTTP or streaming schema.

## 3. Registry vs Manager vs Store

This is one of the defining structural patterns in the SDK:

| Pattern | Owns | Does not own |
| --- | --- | --- |
| Registry | Static definitions and lookup catalogs | Runtime lifecycle |
| Manager | Live orchestration, transitions, and coordination | Durable persistence details |
| Store | Mutable data and persistence | Higher-level orchestration |

Why this exists:

- static catalogs change differently than live runtime state
- orchestration logic becomes clearer when it does not also serialize files
- persistence can evolve without forcing lifecycle logic into the same class

You can see this clearly in:

- `registry/tool/` vs `manager/plan/` vs `store/task/`
- `registry/connector/` vs `manager/connector/`
- session structural rules in `session/` vs durable state in `store/session/`

## 4. Runtime as an Orchestrator, Not a Dumping Ground

The `runtime/` folder does not try to own every agent-related concern. Instead it orchestrates:

- prompt construction
- model calls
- tool review and execution handoff
- iteration sequencing
- result assembly

Why this matters:

- session structure belongs in `session/`
- task persistence belongs in `store/task/`
- advisor logic belongs in `advisory/`
- safety controls belong in `sandbox/`, `verification/`, and `bus/`

This keeps the runtime loop central without letting it absorb every neighboring concern.

## 5. Bridge Pattern

`bridge/` exists because external protocols should not directly shape internal runtime types.

Examples:

- `bridge/sse/` maps `RunEvent` to wire events
- `bridge/mcp/` and `connector/mcp/` adapt between MCP concepts and SDK tool or connector concepts
- `bridge/a2a/` translates to agent-to-agent protocol forms

Why this exists:

- protocol translation becomes explicit and testable
- internal event shapes stay stable even when wire formats differ
- external integrations do not leak deeply into core runtime code

## 6. Tools as a First-Class Boundary

The SDK treats tools as a real architectural boundary, not as a helper function attached to the model call.

That is why tool concerns are split across several folders:

- `tools/` constructs tool definitions
- `types/tool/` defines the shared contract
- `registry/tool/` owns catalog and execution
- `runtime/` decides when tools are exposed and how they are reviewed
- `verification/` can gate them
- `sandbox/` can constrain them

This design makes tools composable across many different runtime modes.

## 7. Session Structure Is a Domain, Not Just Metadata

The size of `session/` is intentional. Session behavior is treated as a first-class domain with:

- hierarchy rules
- workspace isolation
- handoff
- summary materialization
- intervention chains
- migration
- archival and retention

Why this exists:

- project and session structure has rules that are richer than plain persistence
- multi-run or multi-actor workflows need explicit ownership and lineage
- retention and migration have different responsibilities than active execution

This is why the SDK does not collapse all "state" into `store/`.

## 8. Safety Is Layered

The safety model is intentionally spread across multiple folders:

| Folder | Responsibility |
| --- | --- |
| `verification/` | Decide whether an action should be allowed, denied, or reviewed |
| `sandbox/` | Constrain what an action can do if it runs |
| `bus/` | Coordinate locks, edit ownership, and breaker state across runs |
| `telemetry/` | Preserve visibility into what happened |

Why this exists:

- approval is not the same thing as containment
- containment is not the same thing as coordination
- coordination is not the same thing as observability

Each layer solves a different failure mode.

## 9. Extension Packages Stay Out of Core

The SDK keeps extension contracts in core but concrete environment packages outside:

- provider implementations live in published provider packages
- computer-use host implementation lives in `@namzu/computer-use`
- the SDK owns the interfaces, registries, and tool wrappers that let those packages plug in

Why this exists:

- core stays smaller and more neutral
- vendor-specific or OS-specific code does not dominate the package
- runtime orchestration can stay stable while integrations evolve independently

## 10. How to Read New Work Through These Patterns

Before adding a new module, ask these questions:

1. Is this a type contract, a static catalog, a runtime lifecycle owner, or a store?
2. Is this internal domain logic or wire translation?
3. Is this execution behavior or persistence?
4. Is this a safety decision, a containment layer, or an observability surface?
5. Does this belong inside the SDK, or should the SDK only define the contract for an external package?

If those questions are answered well, the folder usually becomes obvious.

## Related

- [SDK Architecture](./README.md)
- [Source Tree](./source-tree.md)
- [Folder Reference](./folder-reference.md)
- [Runtime Pipeline](./runtime-pipeline.md)
- [SDK Root Barrel](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/index.ts)
