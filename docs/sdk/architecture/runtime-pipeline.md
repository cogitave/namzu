---
title: Runtime Pipeline
description: Detailed walkthrough of how @namzu/sdk turns agent input into provider calls, tool execution, checkpoints, and final results.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# Runtime Pipeline

The core runtime path of the SDK lives in `runtime/`, but it relies on several adjacent modules. The easiest way to understand it is to follow a run from `ReactiveAgent.run()` into `drainQuery()` and then through the iteration phases.

## 1. Entry Point

For the common path, execution starts in `agents/ReactiveAgent.ts`:

1. `ReactiveAgent.run()` validates that `sessionId`, `projectId`, and `tenantId` are present.
2. It forwards the request into `drainQuery()` from `runtime/query/index.ts`.
3. `drainQuery()` consumes the async `query()` generator and assembles a final `AgentRun`.

This is why most public runtime behavior eventually converges on the same query pipeline even when the surface API starts at an agent class.

## 2. Query Bootstrap

`runtime/query/index.ts` owns the high-level bootstrap sequence:

```text
query(params)
  -> ensureMigrated(.namzu root)
  -> RunContextFactory.build(...)
  -> wire event translators and optional stores
  -> register dynamic tool surfaces
  -> create prompt, tooling, executor, guards, checkpoints
  -> hand control to IterationOrchestrator.runLoop()
```

Key responsibilities in this stage:

| Module | Responsibility |
| --- | --- |
| `context.ts` | Build run context and initialize the run manager |
| `prompt.ts` | Assemble prompt segments |
| `tooling.ts` | Prepare tool availability and model-facing tool schemas |
| `executor.ts` | Execute tools during a run |
| `guard.ts` | Decide whether iteration should continue or stop |
| `checkpoint.ts` | Create and summarize checkpoints |
| `events.ts` | Translate runtime activity into `RunEvent`s |

## 3. Iteration Orchestrator

`runtime/query/iteration/index.ts` is the center of the loop. It coordinates phases rather than implementing every concern inline.

The practical iteration sequence is:

```text
plan gate
  -> limit and cancellation guard
  -> pending task notifications
  -> compaction check
  -> provider.chat(...)
  -> advisory phase
  -> tool review or direct tool execution
  -> checkpoint
  -> loop or stop
```

## 4. Iteration Phases

The phase modules live in `runtime/query/iteration/phases/`:

| Phase file | Responsibility |
| --- | --- |
| `plan.ts` | Stops at a plan gate if a plan is awaiting approval |
| `compaction.ts` | Replaces old context with structured compacted state when token pressure rises |
| `advisory.ts` | Triggers advisor consultation based on runtime state |
| `tool-review.ts` | Runs verification and HITL review before tool execution |
| `checkpoint.ts` | Writes an iteration checkpoint and asks the resume handler what to do next |
| `context.ts` | Shared iteration context plus HITL decision handling |

## 5. Provider Call Boundary

The LLM boundary is intentionally narrow:

- The runtime prepares normalized messages and tool schemas.
- The provider receives `chat({ model, messages, tools, ... })`.
- The provider returns a normalized `ChatCompletionResponse`.

Because providers implement the shared `LLMProvider` contract, the runtime does not need vendor-specific branching at this point.

## 6. Tool Review and Execution

Tool execution is a two-stage boundary:

1. `tool-review.ts` inspects requested tool calls.
2. If a `VerificationGate` exists, it evaluates allow, deny, or review decisions first.
3. If human review is required, the runtime asks the resume handler for a decision.
4. Approved tool calls execute through the tool executor and append tool messages back into the run.

This split is important because the runtime treats tool approval as a first-class phase, not as an incidental check buried inside tool execution.

## 7. Compaction and Advisory Are Side Paths, Not Separate Loops

Two subsystems often look separate from the main runtime, but they are actually embedded into the same iteration flow:

- `compaction/` reduces context pressure before the next model call.
- `advisory/` injects structured guidance after evaluating trigger conditions.

Neither subsystem creates an alternative run architecture. Both are additions around the same iteration loop.

## 8. Stop Conditions

The loop exits through explicit stop paths:

| Stop path | Trigger |
| --- | --- |
| Guard stop | Token, cost, timeout, or iteration limit |
| Cancellation | Abort signal or explicit cancellation |
| Pause | HITL decision at plan gate, tool review, or checkpoint |
| Final response | Runtime forces a final answer because limits are near |

When the runtime stops, `RunPersistence` and the surrounding query pipeline finalize the `AgentRun` result that the agent surface returns.

## Related

- [SDK Runtime](../runtime/README.md)
- [Source Tree](./source-tree.md)
- [State and Persistence](./state-and-persistence.md)
- [Query Entry Point](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/runtime/query/index.ts)
- [Iteration Orchestrator](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/runtime/query/iteration/index.ts)
