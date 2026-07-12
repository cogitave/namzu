---
title: Runtime Pipeline
description: Detailed walkthrough of how @namzu/sdk turns agent input into provider calls, tool execution, checkpoints, and final results.
last_updated: 2026-07-13
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
  -> compaction check (proactive)
  -> model call (bounded retry + reactive overflow recovery)
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
- The provider receives `chat({ model, messages, tools, signal })`.
- The provider returns a normalized `ChatCompletionResponse`, or throws a normalized `ProviderRequestError`.

Because providers implement the shared `LLMProvider` contract — on the failure path as well as the success path — the runtime does not need vendor-specific branching at this point.

The call itself is not a bare `provider.chat()`. `model-call.ts` wraps it in a bounded retry loop, and the orchestrator wraps *that* in overflow recovery:

```text
callModelWithOverflowRecovery
  -> attemptModelCall            (retry: throttle | server | network,
  |                               jittered backoff, deadline-aware)
  |     -> provider.chat({ ..., signal })
  |
  -> on ProviderRequestError kind 'context_overflow':
       drain pending notifications -> force-compact -> reissue
       (bounded by retry.overflowAttempts; a non-shrinking
        reduction is never committed)
```

Two properties follow from this placement:

- **Retry is inside the iteration, not around it.** A retried call does not consume an iteration, does not re-run the plan gate or compaction check, and does not double-fire hooks. `maxIterations` counts logical turns.
- **Overflow recovery reissues within the same iteration.** The compaction it forces is *reactive* — the safety net for when the proactive threshold check underestimated the payload. The proactive path in `phases/compaction.ts` remains the normal one.

`finishReason: 'length'` is handled at this boundary too: truncated tool-call arguments are sanitized before the assistant message is recorded, and a synthesized not-executed tool result keeps the assistant/tool sequence provider-valid.

See [Reliability and Cancellation](../runtime/reliability.md).

## 6. Tool Review and Execution

Tool authorization is two checks with two different jobs, not one gate consulted once.

1. `tool-review.ts` inspects requested tool calls and, if a `VerificationGate` is
   configured, evaluates each one against it. Deny is global here: any call the
   gate denies is answered immediately and removed from the batch **before** a
   human reviewer ever sees it. No review decision — including approving the
   rest of the batch — can restore a call the gate already denied.
2. The calls the gate did not deny go to a human only if at least one of them
   needs review; if every survivor is already `allow`, the batch executes
   without asking anyone.
3. If human review is required, the runtime asks the resume handler for a
   decision. A `modify` decision rewrites a call's input, and that rewritten
   input is re-evaluated against the gate's deny plane before it is treated as
   approved — a benign call a human approved cannot be modified into a denied
   operation. A `pause` decision — which is also what an absent handler
   returns — **parks the run durably** instead of answering: the question is
   persisted on the checkpoint, the run is marked `awaiting_input`, and the
   generator returns. See [Durable Pause](../runtime/durable-pause.md).
4. Whatever leaves this phase — approved as proposed or approved as modified —
   is still not final. `ToolExecutor` re-evaluates the gate's deny plane one
   more time, against the tool's *final* input, after every `pre_tool_use`
   plugin hook has run and immediately before dispatch. A hook that rewrites an
   allowed call into one the deny rules match is denied at this point rather
   than executed.

This split is important because the runtime treats tool approval as a
first-class phase, not as an incidental check buried inside tool execution.
The review phase decides what a human is asked and what the phase approves;
the executor decides what actually runs, and that second check is the one
nothing downstream of it can bypass. Both fail closed: an exception thrown
while evaluating a rule is treated as a deny. See
[Tool Safety](../tools/safety.md#5-verification-gate) and
[Safety and Operations](./safety.md#9-safety-flow-in-practice) for the full
picture.

## 7. Compaction and Advisory Are Side Paths, Not Separate Loops

Two subsystems often look separate from the main runtime, but they are actually embedded into the same iteration flow:

- `compaction/` reduces context pressure before the next model call.
- `advisory/` injects structured guidance after evaluating trigger conditions.

Neither subsystem creates an alternative run architecture. Both are additions around the same iteration loop.

## 8. Stop Conditions

The loop exits through explicit stop paths:

The loop returns a `RunDisposition` saying **why** it stopped, rather than letting `query()` infer "done" from the mere fact that it returned. There are two dispositions, and the difference is structural:

| Disposition | Meaning |
| --- | --- |
| `completed` | The run is over. Terminalize it, resolve a result, emit a completion event |
| `suspended` | The run is **parked** awaiting an external decision. Non-terminal: no `endedAt`, no result, no `run_completed`, no `run_end` hooks |

`stopReason` cannot carry this. It is a label on the last thing that happened, written by whoever stopped the loop, and deriving a control-flow fact from a description is how a paused run came to be persisted as **completed** before `0.5.0`.

| Stop path | Trigger | Disposition |
| --- | --- | --- |
| Guard stop | Token, cost, timeout, or iteration limit | `completed` |
| Cancellation | Abort signal or explicit cancellation | `completed` (terminal, status `cancelled`) |
| Durable pause | A tool review nobody in-process answered | **`suspended`** — the run parks and can be resumed |
| Plan gate, unanswered | A plan approval with no in-process reviewer | `completed` — the plan is rejected and the run **ends**. It cannot park: the checkpoint captures no `PlanManager` |
| Final response | Runtime forces a final answer because limits are near | `completed` |
| Provider error | A terminal `ProviderRequestError` (`auth`, `bad_request`, `unknown`, or a retryable kind that exhausted its attempts) | `completed` (status `failed`) |

The run's guard clock bounds retries as well as iterations: `attemptModelCall` checks the deadline before each attempt and caps each backoff wait by the time remaining, so a retry storm cannot push a run past its `timeoutMs`. That clock measures **active execution time**, so a run parked for a human is not burning it.

Cancellation reaches the in-flight request rather than only the iteration boundary. `AbstractAgent` composes the agent's internal controller with any caller-supplied `input.signal` into the single signal the query observes, which is what makes `agent.cancel()` abort a call already on the wire — on every provider that declares `supportsAbortSignal`. A run that is already **parked** has no live process to signal, and is cancelled through the persisted record instead (`cancelRun`).

When the runtime stops, `RunPersistence` and the surrounding query pipeline finalize the `AgentRun` result that the agent surface returns. A history left dangling by a cancel or an interruption is healed by `repairDanglingMessages` on the resume or replay path, not carried forward broken — **except** where a persisted decision owns the dangling tool-call block, because there the unanswered call is the question a human is being asked, and repairing it would destroy the decision. See [Durable Pause](../runtime/durable-pause.md).

## Related

- [SDK Runtime](../runtime/README.md)
- [Durable Pause](../runtime/durable-pause.md)
- [Reliability and Cancellation](../runtime/reliability.md)
- [Source Tree](./source-tree.md)
- [State and Persistence](./state-and-persistence.md)
- [Query Entry Point](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/runtime/query/index.ts)
- [Iteration Orchestrator](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/runtime/query/iteration/index.ts)
