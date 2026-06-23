# Namzu: A Technical Architecture Report on a Single-Process Agent Kernel

## Table of Contents

1. [Scope and Framing](#1-scope-and-framing)
2. [Repository Topology and Dependency Direction](#2-repository-topology-and-dependency-direction)
3. [Type and Contract Layering](#3-type-and-contract-layering)
4. [The Run Lifecycle: `query()` Assembly](#4-the-run-lifecycle-query-assembly)
5. [The Iteration Loop: Every Phase and Branch](#5-the-iteration-loop-every-phase-and-branch)
6. [Termination Model: Three Tiers](#6-termination-model-three-tiers)
7. [Tool Subsystem: Registry, Execution, Gating](#7-tool-subsystem-registry-execution-gating)
8. [Context Compaction: The Live Path and the Dormant Path](#8-context-compaction-the-live-path-and-the-dormant-path)
9. [The Session Hierarchy and Handoff CAS](#9-the-session-hierarchy-and-handoff-cas)
10. [Agent Delegation: The Spawn Saga and Budget Model](#10-agent-delegation-the-spawn-saga-and-budget-model)
11. [Persistence and the Store Layer](#11-persistence-and-the-store-layer)
12. [Provider Abstraction and Adapter Translation](#12-provider-abstraction-and-adapter-translation)
13. [Retrieval-Augmented Generation](#13-retrieval-augmented-generation)
14. [Sandbox Isolation](#14-sandbox-isolation)
15. [Cross-Cutting Subsystems: Probe, Bus, Verification, Advisory](#15-cross-cutting-subsystems-probe-bus-verification-advisory)
16. [Plugin System and Connectors](#16-plugin-system-and-connectors)
17. [Applications: CLI, API, Computer-Use](#17-applications-cli-api-computer-use)
18. [Error Taxonomy](#18-error-taxonomy)
19. [Concurrency Model](#19-concurrency-model)
20. [Engineering Process and Governance](#20-engineering-process-and-governance)
21. [Maturity and Limitations](#21-maturity-and-limitations)

---

## 1. Scope and Framing

Namzu is a single-process TypeScript runtime that executes LLM agents and the tools they invoke. The appropriate mental model is an *agent kernel*: a long-lived in-process scheduler that interleaves provider calls with a fixed pipeline of policy phases (resource guards, compaction, tool review, checkpointing, advisory consultation) and streams a durable event log throughout. It is not a distributed system, not an operating system, and not a hosted service; all coordination primitives are in-memory Maps and all persistence is filesystem-local JSON with `write-tmp-rename` atomicity.

This report describes the system as it exists in the code, including subsystems that are fully built but not yet wired into any live path. Where a capability is dormant, the report says so and cites the file proving it. The intended reader is a principal engineer who must reason about, extend, or operate this codebase.

The monorepo ships as the npm scope `@namzu`, lives in the GitHub repository `cogitave/namzu`, and is authored under the git identity `bahadirarda <bahadirarda@users.noreply.github.com>`. These three identities are distinct and should not be conflated.

---

## 2. Repository Topology and Dependency Direction

The workspace is a pnpm monorepo. The dependency direction is strictly enforced and acyclic:

```
contracts  ←  sdk  ←  { agents | api | cli | computer-use | providers }
```

- `@namzu/contracts` — a standalone, unpublished (`private: true`, v0.1.0) leaf package of branded IDs and wire schemas, with no workspace imports.
- `@namzu/sdk` — the kernel: agents, tools, providers, stores, runtime loop, compaction, sessions, manager.
- `@namzu/agents`, `@namzu/api`, `@namzu/cli` — applications.
- `@namzu/computer-use` — an optional subprocess capability package for desktop automation.
- `@namzu/<provider>` — seven LLM adapter packages: `anthropic`, `openai`, `bedrock`, `openrouter`, `ollama`, `lmstudio`, `http`.
- `@namzu/telemetry` — a published OpenTelemetry NodeSDK provider that no other package in the monorepo depends on.

Nothing imports from the same level or above. The SDK depends directly on `@opentelemetry/api` rather than on `@namzu/telemetry`.

A consequential fact established in verification: **`@namzu/contracts` has drifted out of sync with the SDK and `@namzu/api` no longer typechecks.** This is detailed in §3 and §21.

---

## 3. Type and Contract Layering

Namzu enforces a deliberate split between camelCase domain types (internal kernel shapes) and snake_case wire types (HTTP/A2A/SSE payloads), with a bridge layer translating between them.

### 3.1 Branded identifiers

Every entity ID is a TypeScript template-literal brand, e.g. `type RunId = `run_${string}``, defined canonically in `packages/sdk/src/types/ids/index.ts` (40+ IDs: `run_`, `msg_`, `ses_`, `prj_`, `thd_`, `sub_`, `hof_`, `wsp_`, `sum_`, `tnt_`, `agt_`, `task_`, `plan_`, `cp_`, `sbx_`, `plg_`, etc.). The brand is compile-time only — there is no runtime tag.

ID minting lives in `packages/sdk/src/utils/id.ts`. `generateId(prefix, length=12)` uses `node:crypto.randomBytes` with rejection sampling against `MAX_UNIFORM_BYTE = floor(256/36)*36 = 252` to obtain a uniform distribution over the 36-character alphabet `[0-9a-z]` with no modulo bias. The parse functions (`parseRunId`, etc.) validate only the prefix via `startsWith` and cast — they do **not** validate the suffix charset, so `parseRunId('run_!!!')` succeeds at runtime even though the Zod schema regex would reject it.

### 3.2 The three status vocabularies

Three independent status enums coexist, and the live path uses the one the documentation does *not* describe:

1. **`AgentStatus`** (`packages/sdk/src/types/common/index.ts:1`): `'idle' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'`. This is what the runtime actually uses; `RunPersistence.run.status` and `BaseAgentResult.status` are both `AgentStatus`.
2. **`RunStatus`** (`packages/sdk/src/types/run/status.ts`): the eight-state "kernel state machine" enum (`queued`, `running`, `awaiting_hitl`, `awaiting_hitl_resolution`, `awaiting_subsession`, `succeeded`, `failed`, `cancelled`). It is exported but **never produced on the live `completeRun → executor` path.**
3. **`WireRunStatus`** (`packages/contracts/src/api.ts:90`): the seven HTTP states (`queued`, `running`, `completed`, `failed`, `cancelled`, `cancelling`, `expired`).

The documented domain→wire "collapse" (`succeeded → completed`, `awaiting_* → running`) **has no implementing function anywhere.** `ResultAssembler` (`packages/sdk/src/runtime/query/result.ts`) performs no collapse; it only sets an `AgentStatus` via `RunPersistence.markCompleted/markFailed/markCancelled`. The single place a domain status becomes a wire status is a hand-written ternary in the API executor (`packages/api/src/services/run/executor.ts:227-243`):

```ts
const status =
  result.status === 'completed' ? 'completed'
  : result.status === 'cancelled' ? 'cancelled'
  : 'failed'
```

This ternary operates over `AgentStatus`, collapses everything non-`completed`/`cancelled` to `failed`, and passes the `StopReason` through orthogonally as a separate `stop_reason` field. A run that ended on `token_budget`, `timeout`, `max_iterations`, or `plan_rejected` therefore lands on the wire as `completed`, distinguishable only by `stop_reason`.

### 3.3 StopReason as the durable termination invariant

`StopReason` (`packages/sdk/src/types/run/stop-reason.ts`): `end_turn | token_budget | cost_limit | timeout | max_iterations | cancelled | plan_rejected | paused | error`. The runtime invariant "a run that ends always has a StopReason set" is honored because every terminal `mark*` method in `RunPersistence` sets `stopReason`, and `completeRun` propagates `runMgr.stopReason`.

### 3.4 The two contracts surfaces and the drift

There are two physically distinct "contracts" surfaces:

- The standalone `@namzu/contracts` package, consumed **only** by `@namzu/api`, still defines `SessionId` as `sess_` and `ThreadId` as `thd_`, validates `ThreadIdSchema = /^thd_/`, and exports `WireRun` with a `thread_id` field.
- `packages/sdk/src/contracts/*` (the live surface re-exported by the SDK barrel) uses `ses_`/`prj_`, validates `ProjectIdSchema = /^prj_/`, and exports `WireRun` with `project_id`.

This is the Thread→Project rename mid-flight. The standalone package is frozen at the pre-rename world. The consequence (§21) is that `@namzu/api` fails `tsc` with nine errors.

The SDK's public surface is split into three barrels (a ses_011 decision): `public-types.ts` (type-only exports), `public-runtime.ts` (runtime values), and `public-tools.ts` (tool builders).

### 3.5 The SSE event-mapping bridge

`packages/sdk/src/bridge/sse/mapper.ts` is the real camelCase→snake_case translator. Its `MAPPING` is a TypeScript **mapped type** `{[K in RunEvent['type']]: EventTransform<K>}`, which forces exhaustiveness — adding a new `RunEvent` variant is a compile error until the bridge handles it. Five events map to `null` (suppressed on the wire): `run_completed`, `run_failed`, and the three `subsession_*` lifecycle events. The A2A bridge (`packages/sdk/src/bridge/a2a/`) is byte-for-byte duplicated between `contracts/a2a.ts` and `sdk/src/contracts/a2a.ts` — the one place the two surfaces still agree.

---

## 4. The Run Lifecycle: `query()` Assembly

The top-level entry point is `query()` in `packages/sdk/src/runtime/query/index.ts` (an async generator yielding `RunEvent` and returning a final `Run`). `drainQuery()` is the convenience wrapper that fully consumes the generator, invoking an optional listener per event; it defaults a missing `resumeHandler` to `autoApproveHandler`. Both `ReactiveAgent.run` and `SupervisorAgent.run` call `drainQuery`.

`query()` performs synchronous setup, then `return yield* (async function*(){...})()` — the whole run is an inner IIFE generator so the outer function can run setup before the OTEL span/try-block. The assembly order:

1. `await RunContextFactory.ensureMigrated(`${cwd}/.namzu`)` — a boot-time filesystem migration, run at most once per root per process via a module-level `migrationPromises` Map keyed by rootDir. The promise is cached *before* awaiting; only failures invalidate the cache (`.catch(() => migrationPromises.delete(rootDir))`).
2. `RunContextFactory.build(...)` — fully synchronous (deliberately, so migration must be awaited separately). Constructs `RunContext`: `runId`, `RunPersistence`, `ActivityStore`, `PlanManager`, `AbortController` (with a one-shot listener forwarding an external signal), resolved `cwd`, `permissionMode = runConfig.permissionMode ?? 'auto'`, `pathBuilder`, output directories.
3. Wires `planManager.setApprovalHandler` to bridge to `params.resumeHandler` with a synthetic checkpoint id `cp_plan_${planId}` (which corresponds to no persisted file).
4. Builds `EventTranslator` and wires activity/plan/task store events.
5. Conditionally registers task tools (`buildTaskTools(params.taskStore, ctx.runId)`) and `SearchToolsTool` (only if some tool has availability `'deferred'`).
6. `ToolingBootstrap.init` → `ToolExecutor`.
7. Optional `WorkingStateManager` — only if `params.compactionConfig && strategy !== 'disabled'`.
8. `PromptBuilder`, `GuardCoordinator`, `CheckpointManager`, `ResultAssembler`.
9. Optional `AdvisoryContext` — only if `params.advisory && params.advisory.advisors.length > 0`.
10. Optional `VerificationGate` — only if `params.verificationGate?.enabled`.
11. `IterationOrchestrator`.

The inner generator then: starts the root span, calls `runMgr.init()`, builds prompt segments, seeds messages by mode, marks running, emits `run_started`, runs the `run_start` plugin hook (if `pluginManager`), optionally creates a sandbox, runs `iterationOrchestrator.runLoop()`, runs the `run_end` hook, and calls `resultAssembler.completeRun`. On throw → `handleError`; `finally` destroys the sandbox, unsubscribes the task store, and ends the span.

### 4.1 Message seeding modes

- **`resumeFromCheckpoint`**: restores the checkpoint, re-pushes a *freshly built* system prompt (the checkpoint's system messages are stripped), keeps all other roles.
- **`continuationMode`**: pushes `params.messages` verbatim *including* system messages, and does **not** push a fresh system prompt.
- **default**: pushes fresh system messages + non-system `params.messages`, with compaction extraction.

### 4.2 Prompt segmentation for caching

`PromptBuilder.buildSegmented` (`packages/sdk/src/runtime/query/prompt.ts`) splits the prompt into a `static` segment (layers 1–6: base prompt + persona identity/expertise/reflexes/skills/output discipline) and a `dynamic` segment (layers 7–10: tool section, tier guidance, env context, `persona.sessionContext`). It deliberately strips `sessionContext` from static and re-adds it to dynamic so the static block can be marked cacheable. `query()` pushes static as a system message with `cacheControl: 'cache'` and dynamic with `'ephemeral'`. `ContextCache` caches only the static segment keyed by `computeStaticHash` (sha256, first 16 hex chars); the dynamic segment is rebuilt on every call.

### 4.3 Deterministic replay primitive (half-built)

The unit owns checkpoint serialization plus `prepareReplayState`, `applyMutations`, and `listCheckpoints` (`packages/sdk/src/runtime/query/replay/`). `prepareReplayState` resolves a fork point (`'emergency'`, `'latest'` sorted by iteration DESC, or an explicit `CheckpointId`), applies mutations, and builds attribution. `applyMutations` is pure and implements exactly one mutation type, `injectToolResponse`. There is **no** end-to-end `replay()` function — the caller must manually thread `messages` and `sourceCheckpoint.id` into `query()`, and nothing in the codebase does this. Emergency-dump projection (`projectEmergencyToCheckpoint`) is deliberately lossy (zeroes `costInfo`, omits `toolResultHashes`/`branchStack`/`activeNode`).

---

## 5. The Iteration Loop: Every Phase and Branch

`IterationOrchestrator.runLoop()` (`packages/sdk/src/runtime/query/iteration/index.ts`) is the heartbeat. Phases run in a fixed order per iteration. The shared `IterationContext` (`phases/context.ts`) holds all dependencies and the `handleHITLDecision` dispatcher used by the plan gate and the iteration checkpoint.

### 5.1 Pre-loop: the plan gate

Before the loop, `runLoop` registers a `taskGateway.onTaskCompleted` listener that pushes `TaskHandle`s onto `ctx.pendingNotifications`. Then `runPlanGate` (`phases/plan.ts`) fires at most once, only when `planManager.active.status === 'ready'`: it creates a checkpoint, emits `checkpoint_created`, calls `resumeHandler({type:'plan_approval'})`, and routes the decision through `handleHITLDecision`. A `'stop'` signal returns from the generator.

### 5.2 The per-iteration sequence

For each iteration (`index.ts:120-399`), in exact order:

1. **Guard.** `guard.beforeIteration` → if `shouldStop`: `cancelled` (set stop reason, mark cancelled, break) OR `requestFinalResponse` + drain + set stop reason + break; else read the `forceFinalize` flag.
2. **Iteration bookkeeping.** `incrementIteration`, create/start activity, start OTEL iteration span, emit `iteration_started`, drain.
3. **Plugin `iteration_start` hook**, drain.
4. **Notification injection.** If `pendingNotifications.length > 0`, `injectOneTaskNotification` (exactly one per iteration, no wait).
5. **Compaction check.** `runCompactionCheck` (§8).
6. **Tool/message build.** `openAITools = forceFinalize ? undefined : tools.toLLMTools(...)`; on `forceFinalize` append a `[SYSTEM]` "approaching resource limits, give final response" user message.
7. **Plugin `pre_llm_call` hook**, drain.
8. **Provider call.** `provider.chat({model, messages, tools, temperature, maxTokens, cacheControl:{type:'auto'}})`.
9. `accumulateUsage`.
10. **Plugin `post_llm_call` hook**, drain.
11. Emit `token_usage_updated`.
12. Push assistant message (toolCalls dropped if `forceFinalize`), `extractFromAssistantMessage` into working state, emit `llm_response`, drain, set span attributes, complete activity.
13. **Termination branch** (§5.3).
14. **Tool review.** `runToolReview` → `'stop'` returns / `'rejected'` continues / `'executed'` falls through.
15. **Iteration checkpoint.** `runIterationCheckpoint` → `'stop'` returns.
16. **Advisory.** `runAdvisoryPhase` (§15.4).
17. **Plugin `iteration_end` hook.**
18. Emit `iteration_completed(hasToolCalls: true)`, drain, end span.

### 5.3 The termination branch and sub-agent coordination

The termination branch fires when `forceFinalize || finishReason === 'stop' || no toolCalls`:

- If `!forceFinalize && (hasRunningAgentTasks() || pendingNotifications.length > 0)`: emit `iteration_completed(false)`, end span, then `waitAndInjectNotifications()` and `continue`. This is the only place the loop `continue`s after a model `'stop'` finishReason — the model thinks it is done, but the loop keeps it alive to receive sub-agent results.
- Else if `!hasContent && !forceFinalize`: `requestFinalResponse` (guards against blank final answers; early-returns if the last assistant message already has content).
- Then set `StopReason('end_turn')` and break.

`waitAndInjectNotifications` polls every 250ms until `pendingNotifications` is non-empty, a deadline (`runConfig.timeoutMs ?? 120_000`), or abort, then injects exactly one notification. Notifications are drained one per iteration — N completed sub-agents require N iterations (and N LLM calls) to surface.

The injected notification is an in-memory user message: a multiline `<task-notification>` XML block with `<task-id>`, `<agent-id>`, `<status>`, `<description>`, `<result>`, `<remaining-tasks>` children.

`agentBus` is plumbed through `IterationConfig → IterationContext` (`index.ts`, `context.ts:58`) but **is never read anywhere in the loop or any phase** — confirmed by grep returning only declarations.

---

## 6. Termination Model: Three Tiers

Termination is decided by `GuardCoordinator` (`packages/sdk/src/runtime/query/guard.ts`) wrapping the pure `checkLimitsDetailed` (`packages/sdk/src/run/LimitChecker.ts`). The `GuardCoordinator` captures `startTime = Date.now()` at construction (run setup, not first iteration), so setup latency counts against the wall-budget.

`checkLimitsDetailed` checks in fixed precedence:

1. `aborted` → `hard_stop` `'cancelled'`
2. `Date.now() - startTime > timeoutMs` → `hard_stop` `'timeout'`
3. `tokenBudget > 0 && totalTokens >= tokenBudget` → `hard_stop` `'token_budget'`
4. `costLimitUsd > 0 && totalCost >= costLimitUsd` → `hard_stop` `'cost_limit'`
5. `currentIteration >= maxIterations` (default 200) → `hard_stop` `'max_iterations'`
6. then warning tier at `budgetWarningThreshold` (default 0.9) for token, cost, time ratios.

The three tiers are:

- **Hard stop** → `shouldStop: true`. The loop calls `requestFinalResponse` and breaks immediately.
- **Soft `forceFinalize`** → `shouldStop: false, forceFinalize: true` at 90% of any budget. The loop runs **one more** tool-less iteration: tools are stripped (`openAITools = undefined`), a `[SYSTEM]` nudge is appended, and any returned toolCalls are dropped on the assistant message. This coaxes a final textual answer rather than hard-cutting.
- **Natural `end_turn`** → the model stops requesting tools and no sub-agent work is pending.

A consequential dormancy: **the `cost_limit` guard cannot fire in production.** `RunPersistence.accumulateUsage` (`packages/sdk/src/manager/run/persistence.ts:163-169`) only computes cost inside `if (this.pricing)`. `pricing` is never wired — `ReactiveAgent.run` never sets it, `ReactiveAgentConfig` has no `pricing` field, and no nonzero `ModelPricing` is constructed anywhere in the repo. There is also no per-model price table; `calculateCost` (`packages/sdk/src/utils/cost.ts`) reads `promptTokens`/`completionTokens` correctly but is never invoked because the `pricing` guard never passes. `costInfo.totalCost` stays at zero forever, so `0 >= costLimitUsd` is never true. The token and timeout guards do work (token usage accumulates unconditionally).

---

## 7. Tool Subsystem: Registry, Execution, Gating

### 7.1 Class hierarchy

`Registry` (a thin Map wrapper) → `ManagedRegistry` (id resolution, register overloads, `getOrThrow`, overwrite-with-warn on re-register) → `ToolRegistry` (`packages/sdk/src/registry/tool/execute.ts`). Five entity registries reuse `ManagedRegistry`: `AgentRegistry`, `ConnectorRegistry`, `PluginRegistry`, plus `ScopedConnectorRegistry` (the one registry that does *not* extend the base — it uses a composite string key and layered config merging).

### 7.2 Authoring: `defineTool`

`defineTool` (`packages/sdk/src/tools/defineTool.ts`) normalizes boolean-or-function `destructive` into an `isDestructive(input)` predicate, wraps `readOnly`/`concurrencySafe` booleans into thunks, and wraps `execute` so any thrown error becomes `{success:false, output:'', error:'<name> failed: <message>'}`.

### 7.3 The deferred/active/suspended state machine

`ToolRegistry` keeps a parallel `availability: Map<string, ToolAvailability>` (`'deferred' | 'active' | 'suspended'`). The live use case is plugin tools: plugins register namespaced tools as `'deferred'` so they do not bloat the LLM's tool list. The model promotes them by calling the `search_tools` builtin, whose `execute` reaches back through `context.toolRegistry.searchDeferred(query)` (substring match against name or description of deferred-only tools), then `activate()`s every match. `toLLMTools` advertises `active`+`suspended`; `toPromptSection` advertises `active` (full) + `deferred` (name-only, with the instruction "Use search_tools to load these before use"). `suspendAll`/`hasSuspended` and the public `defer` method have no production callers — the `suspended` state is never entered live.

### 7.4 The guarded `execute()` gate order

Inside `tracer.startActiveSpan`:

1. `getOrThrow(toolName)` — **throws** for an unregistered tool (the one place the otherwise all-structured-error contract leaks).
2. Availability check: non-`active` → `{success:false, error:'Tool "x" is <state> and cannot be executed'}`.
3. **Plan-mode gate**: if `context.permissionContext.mode === 'plan'` and `tool.isReadOnly(rawInput)` is falsy → `{success:false, permissionDenied:true, permissionMessage}`. `mode` defaults to `'auto'` when `permissionContext` is absent.
4. Zod `inputSchema.safeParse(rawInput)` — on failure, a structured "Invalid input" error.
5. `await tool.execute(parsed, context)` in try/catch, recording `NAMZU.TOOL_SUCCESS`/`ERROR` span attributes.

Validation runs on `rawInput`; the tool body receives `parseResult.data` (coerced/defaulted).

### 7.5 Parallel batch execution

`ToolExecutor.executeBatch` (`packages/sdk/src/runtime/query/executor.ts`) maps every tool call in a turn through `executeSingle` via `Promise.all` — **all tool calls in one assistant turn run concurrently**, with no ordering or short-circuit. `executeSingle`: JSON-parses arguments (catch → `'Error: Invalid JSON'`), runs `pre_tool_use` plugin hook, emits `tool_executing`, runs the probe veto check, runs the tool, runs `post_tool_use` hook, emits `tool_completed`. Shell-output compression is applied only when `tool.category === 'shell'` and only if it shrinks the output.

### 7.6 Dead and dormant tooling surface

- `ToolDefinition.permissions: ToolPermission[]` is declared and set on every builtin but **read nowhere** (grep confirms zero consumers). Permission enforcement is via `permissionContext.mode`, not this field.
- The tier subsystem (`tierConfig`, `assignTiers`, `toTierGuidance`, `labelInDescription`) is fully implemented and unit-tested but **no production code constructs a `ToolRegistry` with a `tierConfig`**.

---

## 8. Context Compaction: The Live Path and the Dormant Path

The folder `packages/sdk/src/compaction/` contains **two** compaction designs. The clean, well-tested, OO `ConversationManager` strategy family (`StructuredCompactionManager`, `SlidingWindowManager`, `NullManager`, plus `findSafeTrimIndex`/`removeDanglingMessages`) is **dormant** — `createConversationManager`, `applyManagement`, and `reduceContext` have no callers outside tests and barrel re-exports.

### 8.1 The live path

The actual runtime compaction is `runCompactionCheck` in `packages/sdk/src/runtime/query/iteration/phases/compaction.ts`. Algorithm:

1. Skip if no config, `strategy === 'disabled'`, or no `workingStateManager`.
2. `estimateTokens` = `ceil(totalChars / 4)` where `totalChars` sums message content lengths plus assistant toolCall name+argument lengths. `usage = estimatedTokens / tokenBudget`. Skip if `usage < triggerThreshold` (default 0.7).
3. Skip if `messages.length < keepRecentMessages + 2` (default `keepRecentMessages = 4`).
4. Collect a *contiguous leading run* of system messages; if none, return without compacting.
5. `keepStart = messages.length - keepRecentMessages`; `recentMessages = slice(keepStart)`; `olderMessages = slice(systemCount, keepStart)`.
6. `compactedContent` = `serializeState(state)` normally, or `buildVerifiedSummary(...)` (an LLM call) if `llmVerification && slotCount < richStateThreshold`.
7. Replace `messages` in place: `messages.length = 0` then push `[systemMessages, compactionMessage, recentMessages]`. Because `messages` is the live `runMgr.messages` reference, the swap is visible to all holders.

### 8.2 The structured-state accumulator

`WorkingStateManager` (`packages/sdk/src/compaction/manager.ts`) accumulates a structured digest (task, plan, files, decisions, failures, discoveries, environment, tool results, user requirements, assistant notes) via pure extractor functions (`extractFromToolCall`, `extractFromToolResult`, `extractFromAssistantMessage`). List slots use FIFO eviction (`maxListSize = 25`); `toolResults` caps at 30; per-string truncation caps apply. The `files` Map and its action lists are the only unbounded growth.

### 8.3 The orphaned-tool-result hazard (a real bug)

The live splice computes `keepStart` as a raw index and never calls `findSafeTrimIndex` or `removeDanglingMessages`. If `keepStart` lands on a `tool` result message whose matching `assistant(toolCalls)` was in `olderMessages`, then `recentMessages[0]` is an **orphaned tool result** with no preceding `tool_use`. Both providers reject this:

- **Anthropic** (`packages/providers/anthropic/src/client.ts`): `flushToolResults` emits a leading `{role:'user', content:[{type:'tool_result', tool_use_id}]}` with no orphan detection. The API returns `400 invalid_request_error: tool_result blocks must be preceded by a tool_use block`.
- **OpenAI** (`packages/providers/openai/src/client.ts`): a `tool` message maps 1:1 to `{role:'tool', tool_call_id}` with no validation. The API returns `400: messages with role 'tool' must be a response to a preceding message with 'tool_calls'`.

The failure is data-dependent (depends on where `keepStart` lands at the moment usage crosses 0.7), so it surfaces as an intermittent "compaction sometimes kills the run with a 400." The fix already exists, dormant: route `keepStart` through `findSafeTrimIndex(messages, keepStart)` before slicing. The token estimate is also a flat chars/4 heuristic with no real tokenizer, and `resetThreshold` (default 0.4) is parsed but read nowhere.

---

## 9. The Session Hierarchy and Handoff CAS

The session subsystem (`packages/sdk/src/session/`) implements the five-layer hierarchy Project → Thread → Session → SubSession → Run. It is the most rigorously tested unit (~6600 lines of tests). It holds only runtime machinery; entity shapes were relocated to `types/` in ses_010.

### 9.1 Optimistic concurrency via `ownerVersion`

Sessions and Threads carry an `ownerVersion: number` (starts at 0). A `HandoffAssignment` captures `expectedOwnerVersion`. **Thread CAS is enforced at the store boundary**: `DiskThreadStore.updateThread` (`packages/sdk/src/store/thread/disk.ts`) re-reads `thread.json`, compares `ownerVersion`, throws `StaleThreadError` on mismatch, else writes `ownerVersion + 1`. **Session CAS is enforced only in application code** — `DiskSessionStore.updateSession` and the in-memory equivalent perform *no* version comparison (last-write-wins), so session CAS is a non-atomic read-check-write that is safe only under single-event-loop serialization.

### 9.2 The single-recipient handoff state machine

`executeSingleHandoff` (`packages/sdk/src/session/handoff/single.ts`):

1. `assignment.tenantId === tenantId` else `TenantIsolationError`.
2. `threadManager.requireOpen()` first (archived thread fails fastest).
3. Load source; verify tenant/threadId/projectId all match.
4. `source.status` must be `'idle'` else `HandoffLockRejected`.
5. `runStatus.blockingRun()` fan-in check.
6. `validateDepth` only (single transfers ownership of the same session, so no width check).
7. **CAS**: `source.ownerVersion !== expectedOwnerVersion` → `HandoffVersionConflict`.
8. Write source `idle → locked` (**`ownerVersion` unchanged at lock time**), emit `onLocked`.
9. Provision worktree, `createSession(recipient)`, `createSubSession(kind:'user_handoff')`.
10. Commit: source `locked → idle`, `currentActor = recipientActor`, `ownerVersion + 1`, emit `onCommitted`.
11. Any failure in steps 9–10 → `revertLock` (idempotent), rethrow.

The crucial CAS insight: `ownerVersion` is **not** bumped on entering `locked`, only on commit. The lock window holds the same version, so a concurrent actor's CAS check fails because the source is observed already-changed, not because the version moved.

### 9.3 Broadcast handoff: atomic fan-out

`executeBroadcastHandoff` (`broadcast.ts`) rejects lengths 0 and 1, dedupes recipients via `recipientKey` (`user:userId | agent:agentId | system:role`), validates all assignments share the source/broadcastId/expectedOwnerVersion. It commits the source to `awaiting_merge` (not `idle` — the source becomes the merge coordinator) and is all-or-nothing: on any failure, `rollbackBroadcast` tears down in reverse order (dispose worktrees → `deleteSubSession` all → `deleteSession` all → release source lock), with every sub-op swallowing its own error so the primary failure surfaces.

### 9.4 Crash-safe terminalization

`SessionSummaryMaterializer.materialize` (`summary/materialize.ts`) is the kernel-only producer of `SessionSummaryRef` (`materializedBy: 'kernel'` is a type-level literal). On disk, the summary write and the `active → idle` status flip are two sequential `atomicWriteJson` calls (marker-first ordering). A crash between them leaves the summary persisted but the session non-terminal; `recover()` replays the same summary id (treated as flip-only) on boot to heal the window.

### 9.5 Other mechanisms

- **Intervention DAG**: `validatePrevArtifactChain` (`intervention/prev-artifact.ts`) walks `prevArtifactRef` chains, detecting cycles (`ArtifactRefCycleError`) and depth (`InterventionDepthExceeded`).
- **Retention**: `ArchivalManager` + `DiskArchiveBackend` write a marker-last bundle (`subsession.json`, optional `summary.json`/`workspace.json`, `messages.jsonl`, `archive.json` last) with rejection-sampled `arc_` ids.
- **Workspace**: `GitWorktreeDriver` provisions per-session isolated filesystems via `execFile` argv (no shell); dispose treats "not a working tree" as idempotent success.
- **Migration**: `DefaultFilesystemMigrator` performs a boot-time `threads/ → projects/` re-layout (single `fs.rename` of the `runs/` subtree, no EXDEV cross-mount fallback), plus an `acceptLegacyThreadId` `thd_ → prj_` compat window gated by `WINDOW_OPEN = true`.
- **Status fan-in**: `deriveStatus` (`status/derive.ts`) is a pure Run→Session derivation, deliberately **not** publicly re-exported (a follow-up session is required to promote it).

A known asymmetry: `single.ts revertLock` marks a failed recipient session `'archived'` (a Phase-3 stopgap) rather than deleting it, while broadcast rollback was upgraded to true deletion — single handoff can leave orphan archived sessions.

---

## 10. Agent Delegation: The Spawn Saga and Budget Model

`AgentManager` (`packages/sdk/src/manager/agent/lifecycle.ts`, ~900 lines) is the heaviest file in the unit. `sendMessage` is the spawn entry.

### 10.1 The gate-ordered spawn saga

`provisionSpawn` (`lifecycle.ts:376-533`) runs all gates *before* minting a `taskId`, so a rejected spawn leaves `instances`/`spawnRecords` untouched: `requireOpen` → parent-session existence → cross-thread forbidden → cross-project forbidden → project existence → `validateDepth`/`validateWidth` → ancestry walk → `createSession`. Then a try/catch wraps the mutations (`updateSession → active`, `createSubSession(kind:'agent_spawn')`, best-effort workspace provisioning). On any throw, **compensating rollback runs in mandated order: `deleteSubSession` first, then `deleteSession`** (the store cascade is deny-by-default — `deleteSession` throws if a subsession references it). Both cleanup ops `.catch(() => undefined)` so they cannot mask the original error, which is rethrown.

### 10.2 The budget model and its defects

Budget lives as a shared mutable `AgentTaskBudget { total, remaining }` threaded by reference through the entire delegation tree. In `sendMessage`:

```ts
maxAllocation = Math.floor(context.budgetTracker.remaining * config.maxBudgetFraction)  // default 0.5
allocatedTokens = Math.min(options.budgetAllocation?.tokenBudget ?? maxAllocation, maxAllocation)
context.budgetTracker.remaining -= allocatedTokens   // line 134 — eager decrement
const spawnRecord = await this.provisionSpawn(options, context)  // line 139
```

Three confirmed defects:

1. **Decrement before `provisionSpawn`, no refund on throw.** Line 134 mutates `remaining` before line 139. `provisionSpawn` can throw at many gates, and there is no try/catch around the call and no `remaining +=` anywhere. A rejected spawn permanently leaks `allocatedTokens`. The code comment at lines 136–138 asserts the opposite ("no observable state change").
2. **Token count used as a millisecond timeout.** Lines 225 and 249 set `timeoutMs: options.budgetAllocation?.timeoutMs ?? context.budgetTracker.remaining`. The fallback uses *remaining tokens as a wall-clock timeout in milliseconds*, consumed literally by `LimitChecker.ts:24` (`Date.now() - startTime > config.timeoutMs`) and by a second consumer at `iteration/index.ts:414` (the notification-wait deadline). Because the decrement happens first, the child's "timeout" is the parent's leftover budget. With the default 0.5 fraction, a `tokenBudget` of 10,000 yields a ~5-second child deadline that a single real provider round-trip can exceed, hard-stopping the child on `timeout` after one or zero iterations. Wide fan-outs progressively shrink later siblings' timeouts toward zero.
3. **Unsynchronized shared RMW.** `budgetTracker` is passed by reference into `childContext.budgetTracker` (line 155) with no clone; `remaining -= allocatedTokens` across an `await` boundary lets concurrent siblings both read the pre-decrement value and over-allocate beyond the real budget.

### 10.3 `dispose()` is a no-op cancellation

`dispose()` (lines 366-374) calls `cancelAll('' as RunId)`, which delegates to `listByParent('')`, which exact-matches `context.parentRunId === ''`. No genuine spawn has an empty `parentRunId`, so **`cancel()` never fires** — child `childAbortController.abort()` signals are never tripped. `dispose` then immediately `instances.clear()`. In-flight `agent.run()` promises are therefore **leaked, not aborted**: they run to completion against a torn-down manager, and their terminal handlers (`markCompleted`/`markFailed`) early-return because `instances` was cleared, silently dropping summary materialization.

### 10.4 Other manager subsystems

- `RunPersistence` (`run/persistence.ts`) is the per-run mutable accumulator owning a `RunDiskStore` and the `Run` object.
- `EmergencySaveManager` (`run/emergency.ts`) installs signal/exception handlers that dump a run snapshot via temp-then-rename and **always `process.exit()`** — importing and attaching it changes global process-termination semantics.
- `PlanManager` (`plan/lifecycle.ts`) is a single-plan state machine; its `getNextPendingStep`, `updateStepStatus`, and `completePlan` methods have zero callers (the topological step picker is unwired).
- `ThreadManager` (`thread/lifecycle.ts`) gates session creation on the parent thread being open and enforces archive/delete preconditions across stores.

---

## 11. Persistence and the Store Layer

The store unit (`packages/sdk/src/store/`) provides six domains (activity, memory, run, session, task, thread), each with an in-memory reference implementation and (for most) a filesystem implementation.

### 11.1 Atomicity primitives

`atomicWriteJson` (duplicated verbatim across five disk stores) writes to `${path}.tmp` then `rename`s; on error it `unlink`s the tmp. `rename` is the POSIX atomic-replace, so readers never see a partial file. Append-only logs (`messages.jsonl`, `transcript.jsonl`) deliberately bypass tmp-rename — append is treated as the durability primitive. Date serialization is inconsistent across domains: session/thread/summary use ISO strings, while task/memory/run/activity use epoch-ms numbers.

### 11.2 Task store concurrency

`DiskTaskStore.withLock(taskId, fn)` (`store/task/disk.ts`) is the most robust lock in the codebase: a `Map<TaskId, Promise>` per-key lock with a **`while(true)` re-acquire loop** (after awaiting an existing lock, another woken coroutine may have re-claimed the slot, so it re-checks until it sees an empty slot, then synchronously `set`s). `withLocks` acquires multiple locks in lexicographically sorted, deduped order to prevent the A→B/B→A deadlock. A regression test fires 20 concurrent same-id updates with a 2-second deadlock timeout.

### 11.3 A latent task-store bug

Every by-id operation funnels through `findTask` (`disk.ts:431-434`), which reads only `this.taskDir(this.defaultRunId)`. But `create` writes under `params.runId ?? this.defaultRunId` and `list` reads `filter?.runId ?? this.defaultRunId`. **A task created with `runId: A` (A ≠ defaultRunId) is invisible to `get`/`update`/`claim`/`delete`** — they silently return `undefined`/`false`/`null` with no cross-run fallback scan. The multi-run shape exists (`LocalTaskGateway` propagates a shared `taskStore` to sub-agents, and `buildTaskTools(params.taskStore, ctx.runId)` binds each run's tools to that run's id). The bug is **latent** only because `DiskTaskStore` is never instantiated outside tests — the live store is `new InMemoryTaskStore()` (`packages/api/src/services/container.ts:36`), which uses a flat unpartitioned Map and is immune. It is a loaded gun in the public API.

### 11.4 Run-index serialization is per-instance only

`RunDiskStore.addToIndex` serializes via a per-instance promise chain (`indexLock`); it does **not** guard against a second `RunDiskStore` instance or a second process writing the same `index.json` — a confirmed multi-writer lost-update.

### 11.5 Other store facts

- The exported generic `InMemoryStore<T>` with cursor pagination is never extended internally — dead public surface.
- `DiskActivityStore` does not exist; activity is in-memory only, lost on process exit.
- The on-disk directory tree mirrors run lineage physically: child runs live under `<parent>/children/<id>/`.

---

## 12. Provider Abstraction and Adapter Translation

### 12.1 The registry and module augmentation

`ProviderRegistry` (`packages/sdk/src/provider/registry.ts`) holds two module-private Maps (`providers: type→ctor`, `capabilities: type→caps`), making it a per-module singleton. `register` throws `DuplicateProviderError` unless `{replace:true}`. `MockLLMProvider` auto-registers under `'mock'` on SDK import (the sole entry in `package.json#sideEffects`).

Type-safe config narrowing uses TypeScript module augmentation: each provider's `index.ts` (not a `.d.ts`, so it executes at import time alongside `registerXxx()`) does `declare module '@namzu/sdk' { interface ProviderConfigRegistry { anthropic: AnthropicProviderConfig } }`. `ProviderType = keyof ProviderConfigRegistry & string`. **This augmentation is purely type-level with zero runtime effect** — importing a provider barrel does nothing until `register<Vendor>()` is explicitly called.

Critically, the runtime agent path **does not** use `ProviderRegistry.create`: providers are passed pre-constructed into run config, and the iteration loop calls `provider.chat(...)` directly. `ProviderRegistry.create` has no runtime call site. Likewise, `wrapProviderWithProbes` is exported but never instantiated, so `provider_call_*` bus events never fire in the shipped runtime.

### 12.2 Translation mechanisms

Each of the seven adapters follows an identical `index/client/types` triad. The translation logic normalizes vendor APIs to `ChatCompletionResponse`/`StreamChunk`:

- **Anthropic** (`packages/providers/anthropic/src/client.ts`) is canonical: `toAnthropicMessages` extracts system messages, coalesces `tool`-role messages into a single user-role `tool_result` block (`flushToolResults`), and converts assistant `toolCalls` into `tool_use` content blocks. Streaming maintains an `activeTools: Map<contentBlockIndex, {id, name}>` and reattaches the id to `input_json_delta` fragments, which are streamed raw for the consumer to aggregate by index. Every iteration is wrapped in try/catch that yields `{error}` instead of throwing.
- **Bedrock** reconstructs a synthetic `toolConfig` from message history when no tools are passed but history contains tool blocks (Converse rejects otherwise). It attaches `toolChoice: {auto: {}}` — a confirmed defect: on a `forceFinalize` turn the loop deliberately sets `tools = undefined`, but Bedrock re-enables them from history with `auto`, permitting the model to call a tool on the very turn meant to suppress it. The loop's downstream toolCall-drop masks the damage at the cost of a possibly-empty final answer. The correct emulation of "no tools" given history is `toolChoice: {none: {}}`, but `formatToolChoice` collapses `'none'` to `{auto: {}}`.
- **HTTP** is the only adapter with tested translation logic, supporting two dialects (`openai`, `anthropic`) and failing fast with `DialectMismatchError`.
- **LM Studio** declares `supportsTools: true` but `toLMStudioChat` silently drops all tool definitions and tool calls — a confirmed bug.

### 12.3 Two usage vocabularies

`TokenUsage` (response shape: `promptTokens`/`completionTokens`/`cachedTokens`/`cacheWriteTokens`) and `ProviderCallUsage` (bus shape: `inputTokens`/`outputTokens`/`costUsd`) disagree. `instrumentation.extractUsage` is the broken bridge — it reads `usage.inputTokens` off a `TokenUsage`, producing all-`undefined` fields. Because `wrapProviderWithProbes` is never wired, this dormant bug never surfaces, and the main-loop accounting (which uses the correct field names) is unaffected.

---

## 13. Retrieval-Augmented Generation

The RAG subsystem (`packages/sdk/src/rag/`) is a complete, tenant-aware reference implementation that is **dormant** — no agent, API service, or CLI command constructs a `KnowledgeBase` or calls `createRAGTool`.

### 13.1 The pipeline

`DefaultKnowledgeBase.ingest` → `TextChunker.chunk` → `OpenRouterEmbeddingProvider.embed` (batched, response re-sorted by `.index`) → `InMemoryVectorStore.upsert`. Query: `DefaultRetriever.retrieve` → mode branch → `assembleRAGContext` (token-budgeted).

### 13.2 Recursive chunking

`TextChunker.recursiveSplit` tries an ordered separator list `['\n\n','\n','. ',' ','']`. `mergeSmallParts` greedily packs parts into a `chunkSize` budget (default 512) with char-based `chunkOverlap` (default 64) carried over via `overlapStart = max(0, current.length - chunkOverlap)`. Oversize merged chunks recurse with the *remaining* separators; the ultimate fallback is fixed sliding-window chunking.

### 13.3 The hybrid retrieval merge

`DefaultRetriever` supports three modes. The `hybrid` mode runs vector search and keyword search in parallel (each fetching `topK*2`), merges into a `Map` keyed by `chunk.id` with `score = alpha*vectorScore + (1-alpha)*keywordScore` (`alpha` default 0.7); chunks present on only one side get partial weight, then sort and slice to `topK`. The `keyword` mode still embeds the query (to use the vector store as a candidate prefilter at `minScore: 0`) then re-scores with BM25 — so even keyword search requires a working embedding provider.

The BM25 implementation (`bm25Score`) uses `k1=1.2`, `b=0.75`, **a hard-coded `avgDl=256`**, and **no IDF term** — it is effectively TF-saturation plus length normalization, not true BM25 ranking.

### 13.4 Tenant isolation

Multi-tenancy is enforced at exactly one place: `InMemoryVectorStore.search`'s first guard clause (`chunk.tenantId !== query.tenantId → skip`). `namespace` is collected into the scope but never used for isolation. `deleteByDocument` is deliberately *not* tenant-scoped (an asymmetry named in a test), while `deleteByKnowledgeBase` is.

---

## 14. Sandbox Isolation

The sandbox subsystem (`packages/sdk/src/sandbox/`) provides per-run process/filesystem isolation. It is integrated into the tool layer and the query lifecycle but **never activated** — `SandboxProviderFactory.create` is never called and `params.sandboxProvider` is never supplied by any caller.

### 14.1 Backend selection and profile generation

`LocalSandboxProvider` probes the platform once at construction (`detectEnvironment`): on darwin it runs `sandbox-exec -n no-network /usr/bin/true`; on linux `unshare --version`; falling back to `basic`. The three backends:

- **macOS Seatbelt**: `buildSeatbeltProfile` generates an SBPL string: `(version 1)`, `(deny default)`, then explicit allows for process-exec/fork, `file-read*`/`file-write*` `(subpath ROOT)` for the canonicalized sandbox root, reads of system framework paths, `/dev/null` write, temp dirs, a fixed `mach-lookup` global-name allowlist, and a terminal `(deny network*)`. Passed inline via `sandbox-exec -p <profile>`.
- **Linux namespaces**: `unshare --mount --pid --fork --map-root-user`. There is **no** chroot/pivot_root, no bind mounts, no seccomp, and no network namespace — so filesystem isolation relies entirely on the JS path jail, not the mount namespace, and a spawned process can reach the entire host filesystem via raw syscalls.
- **basic**: raw spawn, optionally `ulimit -v`/`-u` wrapping.

`canonicalizePath` wraps `realpathSync`, falling back to manual `/var/* → /private/var/*` and `/tmp/* → /private/tmp/*` rewrites because macOS evaluates real paths in SBPL.

### 14.2 The path jail and a latent bug

`assertInsideSandbox(root, target)` resolves `target` against `root` and throws `Path escapes sandbox` if the relative path starts with `..` or is absolute. This protects only the sandbox's own `readFile`/`writeFile`/`exec`-cwd helpers, not spawned-process syscalls.

A confirmed latent bug: `bash.ts:43-48` passes `cwd: context.workingDirectory` (the *host* project absolute path) into `sandbox.exec`, which calls `assertInsideSandbox(rootDir, hostPath)`. Because `target` is absolute, `resolve` returns it unchanged, `relative(tmpRoot, hostPath)` starts with `..`, and **every sandboxed bash call throws deterministically on the first call.** Neither `bash.ts` nor `buildToolContext` rewrites `workingDirectory` to the sandbox root. The sandbox is therefore dormant *and broken* — wiring it in today would break bash immediately.

---

## 15. Cross-Cutting Subsystems: Probe, Bus, Verification, Advisory

### 15.1 The probe registry (the real event hub)

`ProbeRegistry` (`packages/sdk/src/probe/registry.ts`) is the actual event bus. `dispatch(event, ctx, betweenTier?)` runs in fixed tiers: typed observers (`on`) → optional `betweenTier` callback → catch-all observers (`onAny`). Each kind bucket is priority-sorted via binary-insertion (ascending priority, ties by registration id). Events are shallow-frozen before fan-out. A throwing handler is caught and logged, never propagated.

`queryVeto(event, ctx)` is the veto path, restricted to the single `VetoableEventKind = 'tool_executing'`. It iterates priority-sorted veto handlers, records the **first deny but does not short-circuit** (later handlers still run for audit), and returns `firstDeny ?? {action:'allow'}`. The executor (`executor.ts:159-185`) calls `queryVeto` after emitting `tool_executing` but before `tools.execute`; a deny is converted to an `Error:`-prefixed tool result (not a thrown exception), so the model sees a tool error and the run continues.

**No production code registers a veto handler** — grep for `.veto(` returns only `registry.test.ts`. The gate is a no-op (allow-everything) in the shipped runtime, and the executor's deny branch has no integration test.

### 15.2 The agent bus (dormant)

`AgentBus` (`packages/sdk/src/bus/`) wraps three in-memory primitives: `FileLockManager` (TTL file leases with polling acquire), `EditOwnershipTracker` (path-normalized soft ownership), and `CircuitBreaker` (per-RunId `closed/open/half_open`). `AgentBus.emit` delegates to the global `ProbeRegistry` using the listener Set as the `betweenTier` callback. The entire subsystem is fully built and property-tested but **never instantiated** — `new AgentBus` appears only in tests, and the `agentBus` field threaded through the query pipeline is never read. The `sandbox_decision` event variant has zero emitters. `CircuitBreaker.canExecute` is a read-with-side-effect (it can transition `open → half_open` and emit).

### 15.3 The verification gate (wired, opt-in)

`VerificationGate` (`packages/sdk/src/verification/gate.ts`) is a synchronous, pure first-match-wins policy engine returning `'allow' | 'deny' | 'review'`. The rule union (`types/verification/index.ts`) is the closest analog to a claude-code-style ruleset: `allow_read_only`, `deny_dangerous_patterns`, `allow_by_category`, `allow_by_name`, `deny_by_name`, `custom_pattern`, `allow_by_tier`. The constructor pre-expands convenience flags into rules and pre-compiles regexes and name Sets indexed by rule position. The default decision (disabled or no-match) is `'review'` — the unknown is never auto-allowed.

Contrary to a common mischaracterization, **the gate is wired, not dormant**: `query()` constructs it at `index.ts:303-304` when `params.verificationGate?.enabled` is truthy and threads it through to `runToolReview` (`phases/tool-review.ts:41-85`), which batches decisions: `allAllowed` → execute (skip human review); `allDenied` → push a `[SYSTEM]` block message; mixed or any `review` → fall through to the HITL `tool_review_requested` checkpoint. It is an opt-in subsystem reachable via `query({ verificationGate })`, **not** connected to `permissionContext.mode`. `DANGEROUS_PATTERNS` is a four-entry, Linux-shell-centric list (`rm -rf /`, `mkfs`, `dd if=`, fork bomb), and `allow_read_only` never matches because `isReadOnly` predicates exist on builtins but the rule is rarely configured.

### 15.4 The advisory loop (Phase 1)

The advisory subsystem (`packages/sdk/src/advisory/`) lets a running agent consult a separate advisor LLM, reactively via a `consult_advisor` tool or proactively via trigger rules evaluated between iterations. `runAdvisoryPhase` (`phases/advisory.ts`) builds a `TriggerEvaluationState`, evaluates triggers, takes **only `firedTriggers[0]`** (priority-sorted; the rest are discarded that round), consults the advisor with `toolChoice: 'none'` (text-only oracle), and injects an `<advisory-result advisor="..." trigger="...">` user message. It is dormant by default (the shipped agents do not set `advisory`) but reachable per-run via config. Structured-result parsing is stubbed (`parseResult` returns only `{advice: rawContent}`), and `computeCost` returns all-zero, so advisory cost is fictional. Only `maxCallsPerRun` of the budget fields is enforced.

---

## 16. Plugin System and Connectors

### 16.1 Plugin lifecycle

`PluginLifecycleManager` (`packages/sdk/src/plugin/lifecycle.ts`) implements an install→enable→disable→uninstall state machine. On `enable`, it dynamic-`import()`s tool/hook JS modules, namespaces every tool as `pluginName:toolName`, registers them as `'deferred'`, and connects stdio MCP clients (double-namespaced as `pluginName:mcp__serverName__toolName`). Failed enable triggers compensating rollback. The whole subsystem is **dormant end-to-end** — no app instantiates `PluginLifecycleManager`.

`executeHooks` runs handlers (post_* in reverse order), races each against a 5-second timeout, and is a pure dispatcher returning a result array. The semantic interpretation lives in consumers, and a confirmed defect exists: the `resume` and `retry` hook actions are first-class in `PluginHookResult` and short-circuit inside `executeHooks` (`lifecycle.ts:444`), but **every consumer throws on them** — `applyLifecycleHookResults` (`runtime/query/plugin-hooks.ts`) and both `interpretPreToolResults`/`runPostToolHook` (`executor.ts`) reject `resume`/`retry` with a thrown `Error`. A plugin returning either action on any event crashes the run. The hook timeout also does not cancel the handler (no `AbortController`).

### 16.2 Connectors and the MCP stack

`BaseConnector` (`packages/sdk/src/connector/`) ships two builtins: `HttpConnector` (REST with api_key/bearer/basic auth) and `WebhookConnector` (HMAC-SHA256-signed POST). The entire MCP protocol is **hand-rolled** — there is no `@modelcontextprotocol/sdk` dependency. `MCPClient`/`MCPServer` speak JSON-RPC 2.0 over `StdioTransport` (newline-delimited JSON over a child process) or `HttpSseTransport`. The only production `MCPClient` instantiation is in `plugin/lifecycle.ts attachMCPServer` (stdio only); `HttpSseTransport` has zero production call sites. `MCPClient.request` has **no timeout** — an unresponsive server leaves the promise pending until `disconnect()`. The Local/Remote/Hybrid execution contexts model where commands run, but `RemoteExecutionContext` has no built-in command handler (no SSH/RDP/API implementation ships).

---

## 17. Applications: CLI, API, Computer-Use

### 17.1 CLI (`@namzu/cli`)

The CLI ships exactly one command, `namzu doctor`, dual-purpose as a bin and a library (`runDoctor`). `DoctorRegistry` (`packages/cli/src/doctor/registry.ts`) runs checks concurrently with per-check (5s) and wall-clock (10s) timeout races, isolates throwing checks, and aggregates into a frozen `DoctorReport` with sysexits-aligned exit codes (0 pass / 1 fail / 2 no-config / 70 internal). A `completed` Map with first-write-wins (`recordCompletion`) defends against the per-check-timeout-vs-resolution race. Of six builtin checks, only `sandbox`(darwin)/`cwd`/`tmpdir`/`telemetry` are real; `providers` and `vault` are intentional inconclusive stubs. A complete Ink/React TUI substrate is built and unit-tested but **not wired** to any command — `bin.ts` emits only plain text or JSON. `DoctorCheck.fix` and SIGINT→130 handling are designed but dormant.

### 17.2 API (`@namzu/api`)

The API is a Hono app exposing REST and the A2A protocol. Route composition uses nested Hono instances: an outer `api` applies `providerMiddleware` (BYOK credential extraction) to all routes; a middle `rest` adds `authMiddleware`; A2A and well-known get only provider middleware. Every run handler follows a `validate → resolve → delegate → respond` contract. All execution funnels through `RunExecutor` (`packages/api/src/services/run/executor.ts`), which drives `agent.run()`, emits SSE via two paths (hand-emitted lifecycle events plus the SDK's `mapRunToStreamEvent`), and persists to in-memory `RunStore`/`ThreadStore`.

The API has significant maturity gaps: persistence is in-memory only (a fully-built `ThreadDiskStore` exists but has zero importers); `authMiddleware` is a no-op outside production; cancellation is cosmetic (no `AbortSignal` reaches the agent); and credentials are BYOK-only via headers (`X-LLM-Provider`, `X-LLM-API-Key`, AWS headers). Most consequentially, **`@namzu/api` does not typecheck** (§21).

### 17.3 Computer-Use (`@namzu/computer-use`)

`SubprocessComputerUseHost` detects the display server at construction, lazily dynamic-imports one of four OS adapters (darwin/x11/wayland/win32) on `initialize()`, and drives the desktop by spawning system CLIs (`screencapture`, `osascript`, `cliclick`, `xdotool`, `maim`, `grim`, `ydotool`, `wtype`, PowerShell). All spawning is `shell:false` with argv arrays, eliminating injection. Capability probing is honest — each adapter's `create()` runs `which`/`where` checks and freezes a capabilities record reflecting actual binaries, not the action union. The `computer_use` tool itself lives in the SDK (`tools/builtins/computer-use.ts`), not the package. PNG dimensions are read via a 24-byte IHDR decode to avoid an image library. Two confirmed defects: macOS scroll is unimplemented, and Wayland scroll passes an invalid `--wheel` flag to `ydotool mousemove`.

---

## 18. Error Taxonomy

Namzu defines ~24 custom error classes, nearly all carrying a structured `details` payload so consumers route on fields rather than parsing strings. Representative families:

| Domain | Classes | `details` shape (selected) |
|---|---|---|
| Session isolation | `TenantIsolationError`, `AncestryCycleError`, `WorkspaceBackendError` | `{cyclePath}` for ancestry |
| Thread lifecycle | `StaleThreadError`, `ThreadClosedError`, `ThreadNotEmptyError` | `{threadId, expectedVersion, actualVersion}`; `{blockingSessions ≤ 50, totalBlockingSessions}` |
| Handoff | `HandoffVersionConflict`, `HandoffLockRejected`, `DelegationCapacityExceeded` | `{sessionId, expected, actual}`; `{dimension, current, limit, sessionId}` |
| Summary | `AgentSummaryTooLongError`, `SessionAlreadySummarizedError` | length bound 4000 |
| Migration | `FilesystemMigrationError`, `StalePrefixError` | `{op}`; truncated raw id |
| Provider | `UnknownProviderError`, `DuplicateProviderError`, `DialectMismatchError` | `{providerType}`; `{dialect, url, status, sample}` |
| Probe | `ProbeNameCollisionError`, `ProbeVetoError` | probe name, reason, kind |
| Concurrency | `ConcurrentInvocationError` | `{agentId}` (no `details` object) |
| Replay | `MutationNotApplicableError` | `{availableToolCallIds}` |

`ConcurrentInvocationError` and `A2AProtocolError` are the only two that break the uniform `error.details` convention (using bare fields).

The wire envelope (`packages/contracts/src/api.ts ApiError`) is `{error:{code, message, type, param?}}` where `type ∈ {not_found, conflict, rate_limit_exceeded, internal_error, validation_error}`. The API `errorHandler` (`packages/api/src/middleware/errorHandler.ts`) infers `type` purely from numeric status (500 → `internal_error`, else `validation_error`), which mislabels thrown 404/403/409 errors. `zodErrorToApiError` surfaces only the *first* Zod issue.

Several errors are accepted but lethal: as noted in §16.1, the plugin `resume`/`retry` actions throw in every consumer; in the iteration loop, `handleHITLDecision` and all plugin-hook interpreters use exhaustive `never`-guard defaults that throw on unknown actions.

---

## 19. Concurrency Model

Namzu is a **single-process, optimistic-concurrency** system. There is no distributed lock, no fs-level advisory lock, and no storage-layer atomic CAS. Safety relies on the Node event loop serializing iterations within a run. The real mechanisms:

1. **`ownerVersion` optimistic CAS** for handoffs (§9.1): thread CAS is store-enforced (`StaleThreadError`); session CAS is application-enforced and technically TOCTOU-racy even in-process (an `await getProject` sits inside the critical section in `single.ts`).
2. **Compensating-rollback "transactions"** (§9.3, §10.1): handoffs and spawns emulate atomicity by tracking partial state and undoing in reverse order, with every cleanup op swallowing secondary errors.
3. **Per-key promise locks** in `DiskTaskStore` (§11.2): the most robust primitive, with sorted multi-lock acquisition to avoid deadlock.
4. **Capacity preconditions** (`DefaultCapacityValidator`): depth and width caps validated before any write.

Several concurrency primitives are dormant or broken:

- `InvocationLock` (`packages/sdk/src/agents/lock.ts`) is defined, unit-tested, and wired into `AbstractAgent.acquireInvocationLock` — but **never invoked** by any archetype. Concurrent agent invocation is not actually prevented at runtime. The `ConcurrencyMode = 'throw' | 'queue'` type exists but `'queue'` is unimplemented.
- `FileLockManager`, `EditOwnershipTracker`, and `InvocationLock` are all in-memory Maps providing zero cross-process protection.
- `AgentManager.dispose` cancellation is a no-op (§10.3), leaking in-flight runs.
- `agent.cancel()` does not cancel a running query: `ReactiveAgent`/`SupervisorAgent` forward `input.signal` to `drainQuery`, not `this.abortController`. Real cancellation flows through `AgentManager.cancel → childAbortController.abort`.

Abort is cooperative throughout: an aborted signal takes effect only at the next `guard.beforeIteration` boundary; an in-flight tool or provider call is not preempted by the guard.

The budget tracker is a shared-by-reference mutable object with eager decrement, no refund on throw, and unsynchronized RMW across `await` boundaries (§10.2).

---

## 20. Engineering Process and Governance

The non-code machinery is itself engineered as a tested artifact, and the repository dogfoods the SDK's own workflow.

### 20.1 Sessions and conventions

Every non-trivial change opens a numbered session folder under `docs.local/sessions/ses_NNN-slug/` holding `README.md`, append-only `progress.md`, and optional `design.md`/`implementation-plan.md`/`open-questions.md`. Frozen sessions emit stable rules into `docs.local/conventions/` (11 active rules, each a two-tier document). Both `docs.local/` and `.namzu/` are gitignored, so the governance corpus is single-machine working memory that never enters commits.

### 20.2 The husky progress gate and its bypasses

`.husky/pre-commit` parses the session index with awk, finds sessions in `draft`/`in-progress`, computes the newest staged-file mtime, and aborts the commit if any active session's `progress.md` is stale relative to staged files. `.husky/post-commit` appends a `- <hash> <subject>` baseline line to every active session's `progress.md`.

Two confirmed gaps:

- The pre-commit hook uses `git diff --cached --name-only --diff-filter=ACMR`, which **excludes deletions (D)**. A deletion-only commit yields an empty staged list, `staged_mtime` stays 0, and the gate `exit 0`s without checking. This was verified empirically. The post-commit hook has no diff filter at all, so the two hooks disagree on what counts as a gated commit.
- The gate keys entirely on a hand-maintained status column that is currently stale (ses_007 marked `in-progress` despite shipped/released work; ses_013 marked `draft` despite three shipped phases). Three sessions match the active filter, so every commit cross-appends to all three.

`--no-verify` is an acknowledged un-closeable bypass, forbidden by policy rather than by the hook.

### 20.3 Release and CI gates

Releases are Changesets-driven: per-PR `.changeset/*.md` files declare bump intent; `release.yml` (on push to main) runs full validation then `changesets/action@v1`, which opens a Version-Packages PR or publishes via OIDC Trusted Publisher (pointed at `cogitave/namzu`). `ci.yml` (on PR) runs a node `[22,24]` matrix with eight expensive gates guarded to node 24: per-module coverage floors (measured−3, no env-var bypass), structural test-presence, public-surface regression (dropped names hard-fail, **added names only warn**), consumer-install (packs all tarballs, asserts no ERESOLVE, plus an OTEL single-instance and span-smoke fixture), publint, and attw. An adversarial `codex-check` loop prompts a second agent for attack rather than approval; generic praise is discarded.

---

## 21. Maturity and Limitations

This section consolidates the code-cited gaps. The system has a coherent and well-tested core (sessions, stores, registry, probe) surrounded by a substantial ring of designed-but-unwired capability.

### 21.1 Build-breaking

- **`@namzu/api` does not compile.** `npx tsc --noEmit` yields nine errors across four files, driven by the Thread→Project contract drift: `'@namzu/contracts' has no exported member 'Run'` (renamed to `WireRun`, `contracts/src/api.ts:112`) at three call sites; `'@namzu/sdk' has no exported member 'ConversationStore'` at two; `Property 'threadId' does not exist on type 'CreateRunFromA2A'` (the interface has `projectId`) at `a2a/service.ts:123,167`; and `ThreadMessage[]` vs `Message[]` mismatches. The A2A `contextId → projectId → threadId` path is broken on both inbound and outbound sides even if the types were patched.

### 21.2 Real but latent bugs (correct behavior depends on a dormant code path being wired)

- **Compaction orphaned-tool-result splice** (§8.3): run-breaking 400 from both providers when the window boundary cuts an assistant/tool pair; the safe-trim fix is dead code.
- **Sandbox bash cwd jail** (§14.2): every sandboxed bash call throws deterministically; latent only because the sandbox is never activated.
- **`DiskTaskStore` defaultRunId-only resolution** (§11.3): cross-run by-id ops silently fail; latent only because the live store is in-memory.
- **`timeoutMs` token-as-milliseconds** (§10.2): child agents get nonsensical wall-clock deadlines; bites the default spawn path.
- **`AgentManager.dispose` no-op cancellation** (§10.3): in-flight child runs leak rather than abort.
- **Bedrock `forceFinalize` tool re-enablement** (§12.2): defeats the loop's tool-suppression intent.
- **Plugin `resume`/`retry` actions** (§16.1): crash the run on any event.

### 21.3 Dormant subsystems (built, often tested, but never wired live)

- The agent bus (file locks, edit ownership, circuit breaker) and the `agentBus` context field.
- The verification gate's veto-via-probe path (no veto handler registered anywhere; the gate's *tool-review* path is wired and opt-in).
- The sandbox subsystem entirely.
- The RAG subsystem entirely.
- The plugin lifecycle manager end-to-end.
- The `wrapProviderWithProbes` instrumentation (so `provider_call_*` events never fire).
- The `ProviderRegistry.create` construction path (providers are injected pre-built).
- The `ConversationManager` strategy family and `findSafeTrimIndex` (the live compaction splice bypasses them).
- The deterministic-replay `replay()` entry point (only `prepareReplayState` and `injectToolResponse` exist).
- The CLI Ink TUI; `DoctorCheck.fix`; the `providers`/`vault` doctor stubs.
- `resolveTaskModel`/`TaskRouterConfig` (config-wired, never consumed — confirmed zero non-test callers and only a declaration-site reference at `query/index.ts:122`).
- The `@namzu/telemetry` package (no monorepo consumer).
- `InvocationLock` runtime engagement and `ConcurrencyMode = 'queue'`.
- `PlanManager` execution/completion methods.

### 21.4 Disabled-by-default and non-functional-stub features

- **`cost_limit` cannot fire** (§6): no price table, `pricing` never wired, `costInfo.totalCost` permanently zero. Token and timeout limits do work.
- **API auth** is a no-op outside production and validates only a prefix even in production.
- **API cancellation** is cosmetic (no `AbortSignal` threaded into the agent).
- **API persistence** is in-memory only.
- **`ToolDefinition.permissions`** is dead (set everywhere, read nowhere).
- **BM25** has no IDF and a hard-coded `avgDl` (§13.3).

### 21.5 Test coverage

Coverage is highly asymmetric. The session unit (~6600 test lines), the store concurrency tests, the registry tests, the probe registry, and the SSE/A2A bridge mappers are thorough. Conversely, the entire `IterationOrchestrator.runLoop` is untested (only the advisory phase has unit tests), the live compaction splice is untested while the dormant `ConversationManager` is well-tested, the four agent archetypes have no tests (only `InvocationLock` does), six of seven provider adapters test only registration mechanics (not translation logic), the MCP wire layer and both transports have zero tests, and `@namzu/api` has no tests at all. The pattern recurs across the codebase: the dormant code is frequently the well-tested code, and the live code is frequently the untested code.

### 21.6 Summary judgment

Namzu is a coherent agent-kernel architecture with genuine engineering rigor in its tested core: the phase-ordered iteration loop, the handoff CAS state machine, crash-safe terminalization, the deferred-tool state machine, atomic filesystem persistence, and an exhaustively-checked event-mapping bridge are real and well-constructed. The system is honest about being early: a large fraction of its advertised surface (sandbox, RAG, plugins, bus, replay, verification veto, per-task model routing, telemetry) is foundation shipped rather than feature delivered, the budget/timeout/cancellation machinery has concrete correctness defects, and the `@namzu/api` application currently does not build due to mid-flight contract drift. A principal engineer taking ownership should treat §21.1 and §21.2 as the immediate work queue, and should not represent any §21.3–21.4 capability as production-ready without first wiring and testing the live path.