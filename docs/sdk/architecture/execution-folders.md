---
title: Execution Folders
description: Deep reference for the execution core of @namzu/sdk, including agents, runtime, compaction, managers, registries, and routing.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# Execution Folders

The execution core is where the SDK turns stable types and registries into live agent behavior. These folders are tightly related, but each exists to keep one architectural responsibility clear.

## 1. Core Execution Shape

The execution layer is easiest to read through this sequence:

```text
agent surface
  -> runtime query pipeline
  -> iteration phases
  -> tool or provider boundary
  -> persistence and reporting
```

The related folders are:

- `agents/`
- `runtime/`
- `compaction/`
- `run/`
- `execution/`
- `manager/`
- `registry/`
- `router/`

## 2. `agents/`

`agents/` defines the user-facing execution styles such as `ReactiveAgent`, `PipelineAgent`, `RouterAgent`, and `SupervisorAgent`.

Why it is separate:

- agent classes are public entry points, not internal plumbing
- each class expresses a distinct orchestration style over the same runtime substrate
- consumers need a readable layer above the lower-level query pipeline

This folder answers: "what kind of agent am I running?"

## 3. `runtime/`

`runtime/` is the orchestration heart of the SDK. It is responsible for building a run, iterating, consulting providers, exposing tools, and shaping the final result.

### 3.1 Runtime Subfolders

| Area | Responsibility | Why it is separate |
| --- | --- | --- |
| `decision/` | Parse decision-like model outputs and resolve fallbacks | Decision parsing is a reusable runtime concern, not a provider concern |
| `query/` | Bootstrap runs, assemble prompt and tooling, emit events, and drive the active run loop | The query path is the main execution spine |
| `query/iteration/` | Coordinate loop-level state and sequencing | The loop should not be inlined inside the bootstrap layer |
| `query/iteration/phases/` | Plan gates, compaction, advisory, tool review, checkpoint, and shared iteration context | Each phase is important enough to own its own file and tests |

### 3.2 Why the Runtime Is Decomposed This Way

The runtime is intentionally not one monolithic class because it has to balance:

- model calls
- prompt assembly
- tool exposure
- review gates
- checkpointing
- plugin hooks
- stop conditions

Breaking those into files and phase modules keeps the iteration loop explicit and inspectable.

## 4. `compaction/`

`compaction/` is a separate top-level folder because context reduction is a subsystem, not just a helper buried inside `runtime/`.

### 4.1 What It Contains

| Module area | Responsibility |
| --- | --- |
| `types.ts` and `interface.ts` | Shared compaction vocabulary and manager contract |
| `manager.ts` and `factory.ts` | Manager orchestration and strategy selection |
| `managers/null.ts` | No-op strategy for disabled compaction |
| `managers/slidingWindow.ts` | Simple trimming strategy |
| `managers/structured.ts` | Structured working-state compaction strategy |
| `extractor.ts` and `serializer.ts` | Convert messages and tool results into compactable state |
| `verifier.ts` | Verify summary quality before accepting compacted state |
| `dangling.ts` | Detect and remove unsafe trim points or unresolved result fragments |

### 4.2 Why `compaction/` Is Not Inside `runtime/`

The runtime decides when to compact. The compaction subsystem decides how to compact safely. Keeping them separate preserves a clean boundary between loop orchestration and context-transformation strategy.

## 5. `run/`

`run/` contains run-scoped helpers such as limit checking and reporting.

Why it is separate:

- not every run concern belongs in the iteration loop
- limits and reporting are reusable across agent styles
- it keeps `runtime/` focused on orchestration instead of absorbing every run detail

## 6. `execution/`

`execution/` holds execution-context abstractions such as local execution behavior.

Why it is separate:

- execution environment is a reusable concept
- connector flows and runtime flows may both depend on execution context
- local versus remote execution should remain abstract rather than being hardcoded into connectors

## 7. `manager/`

`manager/` owns lifecycle orchestration for live runtime systems.

### 7.1 Manager Subfolders

| Area | Responsibility |
| --- | --- |
| `agent/` | Agent lifecycle orchestration |
| `connector/` | Connector lifecycle plus tenant and environment coordination |
| `plan/` | Plan lifecycle and approval-oriented flow |
| `run/` | Run persistence orchestration and emergency-save handling |

### 7.2 Why Managers Exist

Managers keep lifecycle logic out of stores and registries:

- stores persist data
- registries hold definitions
- managers coordinate transitions, listeners, and runtime actions

This is one of the defining Namzu patterns.

## 8. `registry/`

`registry/` owns static definitions and catalog behavior.

### 8.1 Registry Subfolders

| Area | Responsibility |
| --- | --- |
| `agent/definitions.ts` | Static agent definitions |
| `connector/definitions.ts` | Connector definitions |
| `connector/scoped.ts` | Scope-aware connector lookup |
| `plugin/` | Plugin registration surface |
| `tool/execute.ts` | Tool registry, availability, and execution dispatch |

### 8.2 Why Registries Stay Separate

Registries answer "what is available?" Managers answer "what is happening right now?" Stores answer "what is persisted?" Keeping those answers in separate folders avoids architectural confusion.

## 9. `router/`

`router/` currently focuses on task-model routing.

Why it is separate:

- model selection policy is a standalone concern
- routing logic should remain reusable even if runtime orchestration changes
- it leaves room for richer routing without polluting agent classes

## 10. Practical Dependency Rules

The healthy dependency direction in this layer is:

```text
registry + config + types
  -> manager
  -> runtime
  -> agents
```

`compaction/`, `run/`, and `execution/` support that chain without collapsing into it.

## Related

- [SDK Runtime](../runtime/README.md)
- [Runtime Pipeline](./runtime-pipeline.md)
- [Pattern Language](./pattern-language.md)
- [Folder Reference](./folder-reference.md)
- [Iteration Orchestrator](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/runtime/query/iteration/index.ts)
