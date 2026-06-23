# Namzu — Architecture of an Agent Kernel

> A code-grounded technical report. Every claim below was read from the source in this
> monorepo, not from prior documentation. Where something is a stub, dormant, or unwired,
> it is named as such.

Namzu is an **agent kernel**: a single-process TypeScript runtime that runs LLM agents and
the tools they call. A consumer imports one package (`@namzu/sdk`) and, in the common case,
calls one function — `query()` — which drives an agent as an async generator. Each iteration
of the loop calls a model provider, reviews and executes the tool calls the model asked for,
keeps the conversation inside a token budget, and writes a checkpoint to disk before the next
turn. Everything else in the kernel exists to make that loop safe, resumable, observable, and
extensible.

This report describes what each part does and how a single run flows through the system.

---

## 1. What Namzu does

At the smallest scale, Namzu turns a list of messages plus a provider into a running agent:

- `query(params)` returns an async generator that **yields `RunEvent`s** and ultimately a
  `Run` (status, token usage, cost, stop reason). `drainQuery()` collapses that stream into a
  single `Promise<Run>` for callers that do not need streaming.
- The agent calls **tools**. Tools are normalized `ToolDefinition`s that carry safety metadata
  (`readOnly`, `destructive`, `concurrencySafe`, `permissions`, `category`) and a Zod input
  schema. Built-ins cover the filesystem and shell (`Read`, `Write`, `Edit`, `Bash`, `Glob`,
  `Grep`, `Ls`); domain tool builders add task delegation, advisory consults, memory, and RAG.
- Tool calls pass a **verification gate** (allow / deny / review) before running and execute
  inside an **OS sandbox** (Seatbelt on macOS, mount + PID namespaces on Linux).
- The conversation is **compacted** to a typed `WorkingState` when it approaches the token
  budget, and **checkpointed** to disk every iteration so a crashed or paused run can resume.

Around this core the kernel adds agent spawning with budget control, pluggable model
providers, retrieval (RAG), long-term memory, agent-to-agent (A2A) and Model Context Protocol
(MCP) interop, and OpenTelemetry tracing.

---

## 2. Packages and the dependency law

The monorepo ships one kernel and a ring of packages around it. The single structural rule is
that **nothing depends back into the kernel**:

```
contracts  ←  sdk  ←  { providers · computer-use · telemetry · cli · apps }
```

- **`@namzu/sdk`** (v0.4.4) — the kernel. 357 source files across ~24 subsystems, projected
  through ~250 curated public symbols. It has **no `@namzu/*` runtime dependency** (verified:
  zero real `@namzu/*` imports in `sdk/src`); its only peers are `zod`, `zod-to-json-schema`,
  and `@opentelemetry/api`.
- **Providers** — `@namzu/anthropic`, `openai`, `bedrock`, `openrouter`, `ollama`, `lmstudio`,
  `http` (all v0.1.2). Each `peerDepends` on the kernel and registers itself via
  `register<Vendor>()`.
- **`@namzu/computer-use`** (v0.2.1) — a subprocess host that lets an agent drive a desktop
  (screenshot/mouse/keyboard) through platform CLIs, no native addons. `peer`-depends on the
  kernel.
- **`@namzu/telemetry`** (v0.1.1) — the OpenTelemetry exporter stack, kept out of the kernel so
  the kernel depends only on the OTEL API.
- **`@namzu/cli`** — hosts the `namzu doctor` runtime and a TUI substrate.
- **`@namzu/contracts`**, **`@namzu/agents`**, **`@namzu/api`** — local application-tier
  packages (not published).

**The public surface is curated, not exported wholesale.** `src/index.ts` is a 12-line
bootstrap that re-exports three barrel files: `public-types.ts` (types only),
`public-runtime.ts` (runtime values), and `public-tools.ts` (tool producers). The barrels carry
explicit notes on what was deliberately *not* promoted, so the internals can churn while the
import surface stays small and stable.

**The provider seam** is a static `ProviderRegistry` plus TypeScript module augmentation. Each
driver augments `ProviderConfigRegistry` and calls `ProviderRegistry.register(...)` at startup;
`ProviderRegistry.create({ type: 'anthropic', ... })` is then fully type-narrowed at the call
site without the kernel knowing any vendor exists.

> **Limitation.** The published kernel vendors its own `src/contracts`. `@namzu/contracts` is a
> separate leaf used only by `@namzu/api`, and the two copies have **diverged** (`ses_` vs
> `sess_` id prefixes, an extra `ProjectId`). README/version claims in the repo also lag the
> manifests.

---

## 3. The run lifecycle

A run is a single async generator (`IterationOrchestrator.runLoop`). The trace below is read
directly from `runtime/query/iteration/index.ts`.

**Bootstrap (once).** `query()` resolves parameters, runs `ensureMigrated`, builds the run
context (`RunContextFactory.build`), wires the event stream, registers tools (domain tools are
deferred), and constructs the guard, tool executor, checkpoint manager, and orchestrator.

**Plan gate (once).** `runPlanGate` runs before the loop; in plan mode it can pause for human
approval.

**The loop (`while (true)`).** Each iteration:

1. **Guard** — `GuardCoordinator.beforeIteration` checks the abort signal and a pure
   `LimitChecker` (tokens / cost / time / iterations, warn at 0.9, `maxIterations` 200). It can
   stop the run (`cancelled` / `end_turn`) or force a final response.
2. **Plugin hook** `iteration_start`, then any queued sub-agent task notification is injected.
3. **Compaction** — `runCompactionCheck` estimates tokens (chars/4) against
   `tokenBudget × triggerThreshold`; when over, it splices `[system, summary, recent N]` in
   place. A safe-trim index guarantees an assistant tool-call is never split from its result.
4. **Plugin hook** `pre_llm_call`, then **`provider.chat(...)`** is called; usage is
   accumulated and the assistant message pushed. **Plugin hook** `post_llm_call`.
5. **End-turn check** — if `finishReason === 'stop'` or there are no tool calls: if sub-agent
   tasks are still running, the loop emits `iteration_completed` and **waits (250 ms polling)**
   to inject their notifications before continuing; otherwise it finalizes (`end_turn`) and
   breaks.
6. **Tool review + execute** — `runToolReview` runs the verification gate and (if needed)
   human-in-the-loop approval, then executes the batch in parallel; the outcome can be
   `stop`, `rejected` (continue), or proceed.
7. **Checkpoint** — `runIterationCheckpoint` writes an `IterationCheckpoint` and can pause or
   abort on resume.
8. **Advisory** — `runAdvisoryPhase` may consult a separate advisor model and inject an
   `<advisory-result>`.
9. **Plugin hook** `iteration_end`, emit `iteration_completed`, loop.

Throughout, a single **`AbortController` spine** is read by the guard every iteration and by
the executor; an external signal chains into it. A **`RunEvent` stream** is emitted and
persisted continuously and drained to the caller. The run ends via `ResultAssembler.finalize`
into a `Run` carrying status, stop reason, usage, and cost.

> **Limitation.** `resolveTaskModel` and `DecisionParser` are **not** in this loop — they serve
> sub-agent routing and `RouterAgent` classification. The iteration loop itself has no dedicated
> unit test.

---

## 4. Agents and spawning

`AgentManager` is the spawn kernel. A `sendMessage` becomes a **SubSession + Session +
Workspace** triple created behind an invariant gauntlet (`provisionSpawn`): open-state check,
parent/thread/project cross-checks, capacity gates (depth and width), then a transactional
create with **compensating rollback** if any step fails mid-flight.

Five archetypes build on `AbstractAgent`: **Reactive** (the workhorse over `drainQuery`),
**Pipeline** (deterministic steps), **Router** (classify then dispatch), and **Supervisor**
(fork a subtree and collect results); plus `defineAgent`. Lineage is tracked through three
channels: an `ActorRef.parentActor` chain, a `Lineage{ rootSessionId, depth }` record, and an
`InvocationState.parentChain`. Child budgets are split geometrically from a shared pool.

> **Limitation.** `InvocationLock` and `AbstractAgent.cancel → cancelAll` ship wired but are
> unused by the built-in agents; one timeout fallback conflates a token count with milliseconds.

---

## 5. Tools and capabilities

Every callable is normalized to a `ToolDefinition` via `defineTool`. `ToolRegistry` governs a
three-state **progressive-disclosure** model — `deferred → active → suspended` — so the model
does not see the whole catalogue at once; the `search_tools` tool lets the model self-load
deferred tools by query. The registry projects two views: `toPromptSection` (for the system
prompt) and `toLLMTools` (the provider tool schema). `execute()` is a gated pipeline:
availability check → plan-mode gate → Zod parse → run → OpenTelemetry span.

> **Limitation.** `permissions[]` is declarative-only — it is not enforced by `execute()`. Tool
> tiering (steering the model to cheaper tools first) is fully implemented but ships dormant; no
> production tier configuration is wired.

---

## 6. Memory

Two independent halves share the theme of "memory":

- **Working memory (compaction).** Under token pressure the live conversation is distilled into
  a typed `WorkingState` (task, plan, file map, decisions, failures, tool results) with bounded,
  FIFO-evicted lists. The best-tested file in the subsystem is the safe-trim logic (27 cases)
  that keeps tool-call/tool-result pairs atomic.
- **Long-term memory.** An opt-in indexed store (in-memory or disk) with `save` / `search` /
  `read` tools, lexical search (substring + tag AND + status), atomic temp-then-rename writes,
  and a two-tier read (summaries, then full content). **No vector database is required.**

> **Limitation.** The `ConversationManager` strategy layer is exported but dormant — only
> `strategy: 'disabled'` is honored; `'sliding-window'` has no live effect. The two memory
> halves are intentionally independent and not wired together.

---

## 7. Persistence and crash recovery

`session/` owns structural invariants (hierarchy, handoff, summary, archival, migration);
`store/` owns the disk and in-memory implementations. Every state file is written
**temp-then-rename** (atomic). Checkpoints fire per iteration; transcripts are append-only
JSONL. Handoff between owners is a state machine (`idle → locked → compare-and-swap on
ownerVersion → commit | compensating revert`); summary materialization is a two-write atomic
sequence with an idempotent `recover()`. The disk task store uses a per-task async lock map with
canonical-order multi-acquire to avoid deadlock.

> **Limitation.** `EmergencySaveManager.attach()` (the SIGINT/SIGTERM core-dump) is implemented
> but has **zero production callers** — it is unwired.

---

## 8. Safety: verification, sandbox, vault

Safety is a three-part split between *deciding* and *enforcing*:

- **Verification gate (decision).** A rule-based gate evaluates each tool call to allow / deny /
  review with a safe default of `review`. Seven rule types, first-match-wins, a pure
  `evaluateRule` core, and pre-compiled regexes bounded at 500 characters against ReDoS.
- **Sandbox (enforcement).** Deny-default execution: Seatbelt/SBPL on macOS with network
  hard-denied; mount + PID namespaces on Linux. A JS path-jail and env allowlist add defense in
  depth, and capabilities are probed rather than assumed.
- **Vault.** Secrets live behind `retrieve()`, the single audited access point;
  `wrapVaultWithProbes` emits a `vault_lookup` event **without** the secret value.

> **Limitation.** `sandbox/` and `verification/` have **zero unit tests**; Linux has no
> seccomp/network-namespace isolation; the dangerous-pattern list is a four-entry speed bump; the
> gate is not wired into `ReactiveAgent` by default; the vault is in-memory only.

---

## 9. Model providers and the gateway

A provider implements one interface (`provider.chat`) and is registered into `ProviderRegistry`.
Each adapter package follows the same `index / client / types` triad; the module augmentation
must live in `index.ts` so it executes on import. Streaming is a per-vendor async-generator
state machine that stitches partial `input_json_delta` fragments by content-block index. A
`MockLLMProvider` ships pre-registered as the kernel's only intentional import side effect.

> **Limitation.** Instrumentation's `extractUsage` reads a usage shape that does not match the
> providers, so token fields can be undefined in production. `@namzu/http` fails fast on dialect
> mismatch; LM Studio advertises `supportsTools: true` but the client folds tool messages into
> plain text rather than passing tools through.

---

## 10. Interop: bus, A2A, MCP

- **Internal bus.** `AgentBus` plus a circuit breaker, a file-lock manager, and an
  edit-ownership tracker — an in-process coordination primitive.
- **Protocol bridges.** Pure functions translate Namzu's `RunEvent` / `Message` / `Run` to and
  from A2A, MCP, and SSE. The mapping tables are typed as `{ [K in RunEvent['type']]: ... }`, so
  adding an event variant fails to compile until it is handled — schema drift becomes a build
  break. A full JSON-RPC 2.0 MCP client/server lives under `connector/mcp/` with stdio and
  http-SSE transports (the `bridge/*` files are pure mappers, not the wire layer).

> **Limitation.** The entire `bus/` layer is exported but has **zero runtime consumers** — it is
> an opt-in, in-memory library, not cross-process despite the "IPC" framing. A confirmed bug:
> inbound A2A sets `projectId` but the service reads a non-existent `runParams.threadId`, so
> inbound context is silently dropped.

---

## 11. Retrieval (RAG)

A tenant-scoped, interfaces-first pipeline: `chunk → embed → store → retrieve
(vector / keyword / hybrid) → assemble token-budgeted context → expose as the
knowledge_search tool`. Tenant isolation is enforced at the data layer (store and query), not
just in metadata, and it is tested. Hybrid retrieval is `alpha·vector + (1-alpha)·keyword`
merged by chunk id; the recursive chunker is the default.

> **Limitation.** Only one embedding provider and one in-memory (linear-scan) vector store ship,
> so the "swappable backend" claim is unproven against a second implementation; `keyword` mode
> still does an embedding round-trip; token counting is chars/4.

---

## 12. Extensibility

Five composable layers customize an agent without forking it:

- **Advisory** — a mid-run consult on a *separate* provider with `toolChoice: 'none'`: it can
  advise, not act. Trigger-gated with a cooldown and a per-run budget.
- **Personas** — identity / expertise / reflexes / output-format merged into a system prompt.
- **Skills** — disclosure-tiered capability bundles loaded on demand, distinct from tools.
- **Plugins** — an `install → enable → disable → uninstall` lifecycle with namespaced
  contributions and compensating rollback on a failed enable.
- **Connectors** — lifecycle-managed external integrations with MCP interop and built-ins
  (HTTP, webhook).

> **Limitation.** Persona and skills have **zero tests**; the advertised "YAML identity with
> inheritance" is aspirational (no loader resolves `extends`, `mergePersonas` has no internal
> callers); advisory cost is a zero-stub and its structured-result parsing is unimplemented
> (text only).

---

## 13. Observability and configuration

A `ProbeRegistry` is an in-process **observe-and-veto** bus: priority-ordered tiered dispatch
(typed → between-tier → catch-all), frozen events, and throw isolation. Veto is a
chain-of-responsibility first-deny-wins (only `tool_executing` is currently gated). Telemetry is
a no-op by default; `registerTelemetry()` upgrades the global spans live, and the kernel never
imports the OTEL SDK. Runtime configuration is a Zod schema where `parse({})` yields the full
default set, beside a centralized constants tree.

> **Limitation.** The probe bus is exhaustively tested, but an `otel` option is dead, the OTEL
> attribute constants are triplicated (drift risk), and `@namzu/telemetry` has no tests.

---

## 14. Applications: CLI, API, computer-use

- **CLI** (`@namzu/cli`) — `namzu doctor` runs registered health checks with sysexits-aligned
  exit codes, JSON output, and `Promise.race` per-check timeouts; it is also a library
  (`runDoctor`, `registerDoctorCheck`). A TUI substrate is built and unit-tested but **not yet
  wired** to the binary, and there is no SIGINT handler.
- **API** (`@namzu/api`) — a Hono server with a four-step route contract (validate → resolve →
  delegate → respond), layered middleware, a BYOK credential model (no server-side key
  fallback), and a unified `RunExecutor` with execute / stream / thread-run modes; SSE emits
  `run.started → message.created → run.completed`. It has **zero tests**, in-memory persistence,
  a stubbed auth prefix, and cooperative-only cancellation (a cancel sets status but does not
  pass an abort signal to the in-flight run).
- **computer-use** (`@namzu/computer-use`) — `SubprocessComputerUseHost` detects the platform,
  lazy-imports an adapter (darwin / win32 / x11 / wayland), and freezes a probed capability set.
  Actions go through a shell-free `spawn` (the security property) behind a single `computer_use`
  discriminated-union tool with `destructive()` HITL gating.

---

## 15. Engineering process

The project dogfoods a multi-agent discipline and enforces it by machine, not policy:

- Session folders are durable working memory; a ratified conventions catalogue grows as
  sessions freeze.
- A husky pre-commit hook gates `progress.md` freshness for every active session.
- Four CI gates have **no escape hatch**: a coverage floor (measured − 3), test-presence, a
  public-surface regression baseline (~380 names), and a consumer-install check.
- Releases run through Changesets with OIDC trusted-publisher provenance; a red CI never
  publishes.
- Non-trivial plans are cross-checked by an adversarial second agent ("attack, not approval").

> **Limitation.** The gates are SDK-centric (no cross-package coverage floor), and the working
> memory lives in a gitignored folder, so it is not remotely auditable.

---

## 16. Maturity and limitations

Honest summary of where the kernel sits:

- **Strong** — dependency-law enforcement, public-surface governance, persistence/crash-recovery
  design, and the governance process.
- **Solid** — the provider seam and adapters, the tool registry, the spawn saga, RAG contracts,
  and observability.
- **Emerging** — runtime-loop test coverage, the safety layer (untested), extensibility
  (persona/skills untested), the HTTP API (untested), and overall test breadth.
- **Gaps to close before 1.0** — wire the dormant machinery (the bus, emergency-save, a
  production tier config), reconcile the two diverged `contracts` copies, test the load-bearing
  core (iteration loop, sandbox, verification), fix the confirmed bugs (instrumentation usage
  shape, inbound-A2A id mismatch, LM Studio tool passthrough), and regenerate the drifted
  README/version prose from the manifests.

The value of this report is that the short bars are labeled, not hidden.
