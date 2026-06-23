---
title: Folder Reference
description: Detailed top-level folder reference for @namzu/sdk with purpose, ownership, and architectural intent for each module.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# Folder Reference

This page is the direct answer to "why is this folder here?" for the top-level `packages/sdk/src` layout. It focuses on ownership and architectural intent so future contributors can place work in the right subsystem and preserve the existing patterns.

## 1. Foundation Folders

### 1.1 `types/`

`types/` is the internal vocabulary of the SDK. It holds domain-first contracts for agents, runs, tools, providers, sessions, tasks, memory, RAG, connectors, telemetry, and many other areas.

Why it is separate:

- the SDK wants implementation-neutral contracts
- multiple subsystems depend on the same domain shapes
- public barrel exports can expose stable types without exposing concrete files

What belongs here:

- domain types
- config and result shapes
- discriminated unions
- interface contracts

What should not be pushed here:

- orchestration code
- persistence implementations
- protocol translation logic

### 1.2 `contracts/`

`contracts/` is the wire-facing sibling of `types/`. It exists for shapes that external clients or protocol consumers should read directly.

Why it is separate:

- internal camelCase domain models should not automatically become public wire schemas
- protocol compatibility changes at a different pace than internal runtime code

Key contents:

- API envelope and error contracts
- schema helpers
- ID contracts
- A2A-facing contract shapes

### 1.3 `constants/`

`constants/` centralizes domain defaults, limits, names, and behavior constants.

Why it is separate:

- thresholds and defaults should not be scattered across the runtime
- operational values need discoverable ownership by domain
- changing defaults should be surgical

This folder is grouped by domain instead of being a single unstructured constants file.

### 1.4 `config/`

`config/` owns runtime schemas and default configuration assembly.

Why it is separate:

- runtime configuration is a first-class boundary
- configuration validation should not be embedded ad hoc in lifecycle code
- defaults such as compaction, sandbox, agent bus, and plugins need one authoritative source

### 1.5 `utils/`

`utils/` holds reusable infrastructure helpers such as IDs, logging, hashing, abort helpers, shell output compression, and cost utilities.

Why it is separate:

- these helpers are cross-domain
- they support many folders without belonging to one domain model
- keeping them isolated prevents every subsystem from inventing its own local helpers

### 1.6 `version.ts`

`version.ts` exists so the SDK has one explicit exported version constant rather than ad hoc version strings spread across the codebase.

## 2. Execution and Orchestration Folders

### 2.1 `agents/`

`agents/` defines the runtime-facing agent classes: `ReactiveAgent`, `PipelineAgent`, `RouterAgent`, and `SupervisorAgent`, plus the `defineAgent()` helper and invocation lock support.

Why it is separate:

- agent shapes are the user-facing execution entry point
- each agent class represents a different orchestration style over the same runtime substrate
- agent-level abstractions should stay readable without dragging in every subsystem detail

### 2.2 `runtime/`

`runtime/` is the heart of model-turn orchestration. It contains query assembly, prompt building, iteration flow, tool review, completion assembly, and runtime hook execution.

Why it is separate:

- there needs to be one coherent place where a run is turned into model calls and responses
- iteration sequencing is distinct from persistence, tool construction, and session structure

Important subfolders:

- `decision/` for parsing and fallback logic
- `query/` for context bootstrap and active iteration flow
- `query/iteration/phases/` for phase-by-phase decomposition of the loop

### 2.3 `compaction/`

`compaction/` owns context reduction strategies, message trimming safety, working-state serialization, and verified summary building.

Why it is separate:

- compaction changes runtime context shape but is not the runtime loop itself
- multiple strategies need a shared contract and manager layer
- safe trimming and summary verification deserve explicit ownership

Important subfolders and files:

- `managers/` for concrete strategies such as null, sliding-window, and structured compaction
- `extractor.ts` and `serializer.ts` for converting active context into compactable state
- `verifier.ts` and `dangling.ts` for safety checks before and after trimming

### 2.4 `run/`

`run/` contains run-specific helpers such as limit checking and run reporting.

Why it is separate:

- these concerns are tied to active run lifecycle but are more focused than the full runtime loop
- keeping them out of `runtime/` prevents the query path from absorbing every run concern

### 2.5 `execution/`

`execution/` provides execution-context abstractions used by other systems, especially connector flows.

Why it is separate:

- execution environments are a reusable concept, not just a connector detail
- local vs remote execution should stay abstractable

### 2.6 `manager/`

`manager/` owns lifecycle orchestration. It includes agent lifecycle, connector lifecycle, plan lifecycle, and run persistence plus emergency save coordination.

Why it is separate:

- live orchestration logic needs its own layer
- lifecycle operations should not be hidden inside stores or registries
- managers coordinate state transitions without becoming the canonical storage surface

### 2.7 `registry/`

`registry/` owns static definitions and catalog behavior for tools, agents, connectors, and plugins.

Why it is separate:

- static definitions change differently than runtime state
- lookup and registration logic are cleaner when separated from lifecycle concerns
- the same registry pattern can be reused across several domains

### 2.8 `router/`

`router/` is intentionally small today. It holds task-model routing logic such as resolving a model by task type.

Why it is separate:

- model-selection policy is its own concern
- routing logic should remain reusable and independent of the main iteration class

## 3. State and Persistence Folders

### 3.1 `session/`

`session/` is one of the deepest subsystems in the SDK. It models tenant-project-session structure, workspaces, handoff, summaries, interventions, migrations, and retention.

Why it is separate:

- session structure is a domain with real rules, not just a few IDs
- multi-step ownership and lineage logic does not belong in generic stores
- migration and archival need to live close to the session model they evolve

Important subfolders:

- `hierarchy/`
- `workspace/`
- `handoff/`
- `summary/`
- `intervention/`
- `migration/`
- `retention/`
- `events/`

### 3.2 `store/`

`store/` holds mutable persistence implementations for runs, tasks, memory, sessions, activity, and compatibility conversation storage.

Why it is separate:

- persistence strategies should be swappable or evolvable
- stores should not also become orchestration coordinators
- disk and memory variants can coexist cleanly

### 3.3 `gateway/`

`gateway/` currently holds the local task gateway used to hand work into the agent manager.

Why it is separate:

- task gateway behavior bridges higher-level orchestration and agent lifecycle
- it is not a generic store and not a core runtime loop concern

## 4. Extension and Integration Folders

### 4.1 `provider/`

`provider/` keeps the SDK's provider layer intentionally narrow: registry, mock implementation, and telemetry setup.

Why it is separate:

- core owns provider contracts and registration, not every vendor implementation
- the provider boundary should stay small and reusable across external provider packages

### 4.2 `connector/`

`connector/` is the integration surface for connectors, execution contexts, and MCP tooling.

Why it is separate:

- connectors are not just tools and not just providers
- they need their own domain model around external systems, transport, and execution scope

Important subfolders:

- `builtins/`
- `execution/`
- `mcp/`

### 4.3 `bridge/`

`bridge/` translates internal runtime data into protocol or transport-specific shapes.

Why it is separate:

- protocol adaptation should stay explicit
- wire mappings should not dominate the core domain folders
- internal runtime types should not be forced to mirror external transports

Important subfolders:

- `a2a/`
- `mcp/`
- `sse/`
- `tools/`

### 4.4 `plugin/`

`plugin/` owns plugin discovery, resolution, and lifecycle hook execution.

Why it is separate:

- plugin activation is a platform concern with its own lifecycle
- runtime hooks need controlled entry points rather than arbitrary patching

### 4.5 `persona/`

`persona/` assembles and merges persona data into prompt-facing structures.

Why it is separate:

- persona identity is not the same thing as runtime orchestration
- keeping prompt identity separate from agents and tools makes prompt composition easier to reason about

### 4.6 `skills/`

`skills/` discovers, loads, and chains skill artifacts.

Why it is separate:

- skills are reusable guidance assets
- the loader and registry logic should not be mixed into persona or tool code

### 4.7 `rag/`

`rag/` owns retrieval-related building blocks: chunking, embeddings, vector storage, retrieval, knowledge-base assembly, and the RAG tool surface.

Why it is separate:

- retrieval is a coherent subsystem with its own vocabulary and pipeline
- it needs to integrate with the runtime without becoming part of the core query loop itself

### 4.8 `advisory/`

`advisory/` owns advisor registration, trigger evaluation, and advisor execution context.

Why it is separate:

- advisory is meta-reasoning about the run, not the same thing as the main model call
- triggers, budget checks, and advisor execution form a subsystem of their own

### 4.9 `tools/`

`tools/` is the construction layer for tool definitions and tool families.

Why it is separate:

- tool definition is a reusable authoring concern
- built-in tools and domain-specific tool groups deserve organized ownership
- execution catalog behavior belongs in `registry/tool/`, not in the tool constructors themselves

Important subfolders:

- `builtins/`
- `task/`
- `memory/`
- `advisory/`
- `coordinator/`

## 5. Safety and Operations Folders

### 5.1 `sandbox/`

`sandbox/` owns containment for command and filesystem execution.

Why it is separate:

- sandboxing is an operational boundary
- the runtime should ask for a sandbox provider, not hardcode one-off execution logic everywhere

### 5.2 `verification/`

`verification/` owns the pre-execution decision layer for tool calls.

Why it is separate:

- review policy is distinct from runtime orchestration
- the decision to allow a tool is not the same as the mechanism that executes it

### 5.3 `bus/`

`bus/` owns coordination primitives such as file locks, edit ownership, and circuit breaking.

Why it is separate:

- concurrent agent coordination is a cross-cutting systems problem
- lock and ownership semantics should not be embedded ad hoc in unrelated modules

### 5.4 `telemetry/`

`telemetry/` centralizes tracing, metric helpers, and shared attribute definitions.

Why it is separate:

- observability needs stable naming and reuse
- telemetry is cross-cutting and should not be buried in runtime internals

### 5.5 `vault/`

`vault/` holds credential storage abstractions and the in-memory implementation.

Why it is separate:

- secret handling should have explicit ownership
- credential storage is not a provider concern and not a generic utility

## 6. The Practical Rule for Contributors

If you are unsure where a new change belongs, classify it first:

1. vocabulary and contracts
2. static definitions
3. runtime lifecycle
4. persistence
5. protocol translation
6. extension surface
7. safety or operations

Once the change is classified this way, the correct folder is usually already implied by the existing architecture.

## Related

- [SDK Architecture](./README.md)
- [Pattern Language](./pattern-language.md)
- [Foundation Folders](./foundation-folders.md)
- [Execution Folders](./execution-folders.md)
- [Session and Store Folders](./session-and-store-folders.md)
- [Integration Folders](./integration-folders.md)
- [Source Tree](./source-tree.md)
- [Runtime Pipeline](./runtime-pipeline.md)
- [Session Barrel](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/session/index.ts)
