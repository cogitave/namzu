# Namzu — An Operating System for AI Agents

**A dependency-free, fully controllable kernel that runs, isolates, schedules, remembers, and coordinates AI agents.** Your UI, chat interface, voice surface, CLI, or automation pipeline sits on top of a stable kernel instead of reinventing the hard parts: sandbox isolation, process lifecycle, signals, checkpoints, memory, protocol interop, and audit.

[![npm](https://img.shields.io/npm/v/@namzu/sdk?color=blue)](https://www.npmjs.com/package/@namzu/sdk)
[![CI](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-FSL--1.1--MIT-green)](./LICENSE.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)

---

## The Thesis

Most "agent frameworks" today are really application frameworks. They ship chat UIs, picking UI layouts, batteries-included hosted dashboards, vendor-specific fast paths, and integration drivers for a handful of databases. You get something you can demo in an hour, and three months later you own a stack where the same framework dictates your frontend, your database, your observability, and your model vendor.

We think agent software should be layered like Unix. At the bottom there needs to be a **kernel**: something to isolate processes, schedule tool calls, manage memory pressure, propagate signals across a call tree, persist checkpoints so a run can resume after a crash, mediate inter-process communication, and produce an auditable event stream. Above the kernel there is user space — shells, editors, IDEs, voice gateways, React apps. The kernel does not care which shell you pick; the shell cannot break the isolation the kernel provides.

**Namzu is the kernel.** It runs agents the way Unix runs processes. It does not render UI, it does not pick your database, it does not favor one LLM vendor. It gives you a surface — typed, versioned, documented — that any UI, any storage backend, and any model can plug into. The surface is small and stable; the guts underneath are deep.

---

## What Namzu Is

Namzu is a single-process TypeScript kernel with the following responsibilities:

- **Process execution and isolation.** Tools run inside OS-level sandboxes: Seatbelt (SBPL) on macOS, mount + PID namespaces on Linux. Deny-default file I/O, scoped network access, enforced resource limits. No Docker, no container runtime, no daemon, no sidecar.
- **Agent lifecycle.** Parent/child agent spawn with depth tracking, budget splitting, and causal trace linkage. A supervisor can fork a subtree of agents and get their results back, with each child isolated from its siblings.
- **Scheduling.** Per-run token, cost, wall-clock, and iteration budgets. Limit checker, task router (cheap model for compaction, expensive for coding), tool tiering (LLM learns to prefer cheaper tools first).
- **Signals.** `AbortController` tree spanning parent and children. `cancel(taskId)` and `cancelAll(parentRunId)` propagate. Runs can be paused and resumed, aborted cleanly, and emit lifecycle events for every transition.
- **Memory management.** Working memory via structured compaction to a typed `WorkingState`. Long-term memory via an indexed, tag/query/status-searchable store with disk persistence. No vector database required by default.
- **Durability.** Atomic per-iteration checkpoints, automatic emergency core-dump on SIGINT/SIGTERM, separate storage for runs, threads, conversations, activities, memories, and tasks.
- **IPC.** Native A2A (Google agent-to-agent) and MCP (Anthropic Model Context Protocol) — both client and server, one SDK. An internal event bus with circuit breakers, file lock manager, and edit ownership tracking so concurrent agents do not stomp on each other.
- **Capability system.** Tools are first-class, typed, permissioned, and progressively disclosed. The LLM does not see the full tool catalog; tools start deferred, get activated on demand, and can be suspended. Each tool declares `readOnly`, `destructive`, `concurrencySafe`, `permissions`, `category`.
- **Syscall filtering.** Every tool call goes through a verification gate — allow / deny / ask, with built-in rules for read-only allowlist and dangerous pattern deny-list, plus custom regex rules. This is separate from sandbox isolation; it is the decision layer, the sandbox is the enforcement layer.
- **Retrieval-augmented context (RAG).** A full pipeline: chunking, embedding providers, ingestion, knowledge base storage, vector store, retriever, context assembler, and a first-class `rag-tool`.
- **Skills.** Disclosure-tiered capability bundles that the agent can load on demand, distinct from tools.
- **Personas.** YAML-defined identity, expertise, reflexes, and output format with inheritance — specialize a base persona by merging a single field, no prompt concatenation.
- **Advisory system.** Mid-execution consultation with specialized advisors. Provider-agnostic: put a security advisor on Bedrock, an architecture advisor on OpenRouter, and let the main agent decide when to consult whom.
- **Human-in-the-loop.** Structured plan review, per-tool approval with destructiveness flags, typed decision contracts, checkpoint/resume across sessions.
- **Plugin system.** Lifecycle-hooked plugin loader with MCP contributions, tool contributions, and manifest-driven resolution.
- **Multi-tenant isolation from day one.** Connector registries, vaults, config, and stores are tenant-scoped. Two organizations can share a process without cross-contamination.
- **Provider abstraction.** OpenRouter and AWS Bedrock today; the `Provider` interface is narrow enough that adding another vendor is an afternoon. BYOK everywhere, no hidden hot paths for any vendor.
- **Telemetry.** OpenTelemetry-native spans and metrics. Cost accounting (input tokens, output tokens, cached tokens, cache write tokens, cache discount) flows from the provider into per-run, per-tenant rollups.
- **Prompt cache integration.** Hash-based system-prompt cache per thread, integrated with provider cache controls (OpenRouter `cacheControl` today, more planned), plus full cache telemetry in every run.
- **Vault.** BYOK credentials and secrets, tenant-scoped, pluggable backend.
- **Thread / Run separation.** Conversations (thread: user ↔ assistant messages across sessions) are cleanly separated from runs (tool calls, iterations, internal state). Multi-turn dialogs carry only the context that matters.

Every one of those bullets points at code that exists today in `src/`. The architecture is deep even where the surface is quiet.

## What Namzu Is Not

Equally important for scoping expectations:

- **Not a chat SDK.** There are no React, Svelte, or Vue hooks, no generative UI components, no `useChat`. Your UI framework is your choice; the kernel hands you a typed event stream.
- **Not a hosted service.** There is no dashboard, no Namzu Cloud, no billing page. You run it in your own process.
- **Not a deployment adapter.** No Next.js, Hono, Express, or Cloudflare Workers plumbing in the kernel. Those belong in separate packages or your own infra code.
- **Not a dev studio.** No bundled playground UI. A playground that consumes the kernel's event protocol could exist as a separate tool; it would not live inside `@namzu/sdk`.
- **Not a vector database.** RAG ships with a pluggable `VectorStore` interface, but the kernel does not embed pgvector or Pinecone. Bring your own.
- **Not an LLM router service.** Task routing is an in-process policy, not a hosted service.
- **Not a prompt management UI.** Personas are code-defined (YAML files in your repo), not database rows behind a web form.

The goal of that list is not to be minimal — the kernel is plenty rich. The goal is to keep the kernel's **interface surface** small and stable so the layers above can move fast without breaking what is underneath.

---

## The Complete Feature Map

How Namzu compares, category by category. Framework category tells you what job the project actually does.

| | **Namzu** | LangGraph | CrewAI | Mastra | Vercel AI SDK | OpenAI Agents SDK |
|---|---|---|---|---|---|---|
| Category | **Agent Kernel** | Graph framework | Crew framework | TS app framework | Frontend-first SDK | Vendor SDK |
| Language | TypeScript | Python/JS | Python | TypeScript | TypeScript | Python/JS |
| Process sandbox (OS-level) | ✅ Seatbelt + NS | ❌ | ❌ | ❌ | ❌ | ❌ |
| Multi-tenant from day 1 | ✅ | ❌ | ❌ | partial | ❌ | ❌ |
| Sub-agent spawn (`fork`/`exec`) | ✅ parent/child/depth/budget | via graph | crews | ✅ | ❌ | handoffs |
| Signal propagation tree | ✅ AbortController + cancelAll | ❌ | ❌ | partial | ❌ | ❌ |
| Checkpoint + resume | ✅ per-iteration | ✅ per-superstep | ❌ | partial | ❌ | sessions |
| Emergency save on signal | ✅ `EmergencySaveManager` | ❌ | ❌ | ❌ | ❌ | ❌ |
| Resource quotas (token / cost / time) | ✅ per run + per child | manual | manual | manual | ❌ | manual |
| Provider prompt cache wired | ✅ `ContextCache` + telemetry | ❌ | ❌ | partial | ❌ | ✅ |
| Thread ↔ Run separation | ✅ | ❌ | ❌ | ✅ | ❌ | partial |
| Native A2A protocol | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Native MCP (client + server) | ✅ | plugin | ❌ | ✅ | ❌ | client only |
| RAG built into the kernel | ✅ full pipeline | via integrations | via integrations | plugin | ❌ | via tools |
| Persona inheritance (YAML) | ✅ merge-based | ❌ | role strings | partial | ❌ | instructions |
| Advisory system (multi-advisor) | ✅ provider-agnostic | ❌ | ❌ | ❌ | ❌ | ❌ |
| Structured context compaction | ✅ WorkingState | ❌ | ❌ | partial | ❌ | ❌ |
| Tool tiering (cost-aware) | ✅ user-defined | ❌ | ❌ | ❌ | ❌ | ❌ |
| Task routing (per-task model) | ✅ fallback chains | manual | manual | manual | ❌ | manual |
| Progressive tool disclosure | ✅ deferred/active/suspended | ❌ | ❌ | ❌ | ❌ | ❌ |
| Tool-call verification gate | ✅ allow/deny/ask + custom | ❌ | task-level scope | ❌ | tool approval | ❌ |
| File ownership / edit locking | ✅ `EditOwnershipTracker` | ❌ | ❌ | ❌ | ❌ | ❌ |
| Circuit breakers on the bus | ✅ `CircuitBreaker` | ❌ | ❌ | ❌ | ❌ | ❌ |
| Skills system (separate from tools) | ✅ disclosure-tiered | ❌ | ❌ | ❌ | ❌ | ❌ |
| Plugin system with lifecycle | ✅ | ❌ | ❌ | partial | ❌ | ❌ |
| Vault / BYOK | ✅ tenant-scoped | ❌ | ❌ | ❌ | ❌ | ❌ |
| Telemetry (OpenTelemetry) | ✅ native | via LangSmith | CrewAI+ | partial | ❌ | built-in tracing |
| Provider lock-in | none | low | low | low | low | OpenAI-first |

---

## Architecture in Depth — Every Subsystem

Every folder under `src/` maps to a traditional OS concept. This section walks them one by one, in the order a request actually flows.

### 1. The Boundary: Sandbox (`sandbox/`)

Sandboxing is the foundation. Tools do not execute in the host process; they execute inside an OS-enforced jail with deny-default file I/O and scoped network access. macOS uses Seatbelt profiles in SBPL format (the same mechanism Apple's own apps use). Linux uses lightweight mount + PID namespaces, without requiring Docker, systemd, or any container runtime. The `SandboxProvider` abstraction (`sandbox/factory.ts`, `sandbox/provider/`) means you can swap in a Firecracker or gVisor-backed provider later without touching the rest of the kernel.

The kernel enforces memory, timeout, and max-process limits on top of whatever the sandbox gives you. The goal: a rogue or hallucinated tool call should never wipe your filesystem or exfiltrate arbitrary data, even if the LLM tries very hard.

### 2. Interprocess Communication: Bridge (`bridge/`) and Bus (`bus/`)

Two layers here, with different jobs.

**Bridge** is cross-process and cross-agent communication. The `bridge/a2a/` folder speaks Google's Agent-to-Agent protocol: your agents can publish agent cards describing their capabilities and can discover and invoke other agents' capabilities. The `bridge/mcp/` folder speaks Anthropic's Model Context Protocol, both as a client (consume MCP servers as tools) and as a server (expose your Namzu tools to any MCP-speaking agent). The `bridge/sse/` folder contains the event mapper that turns in-process events into Server-Sent Events for any consumer on the other side of HTTP. `bridge/tools/` wires it all into the tool system.

**Bus** is in-process. This is where the kernel's internal nervous system lives. The bus emits typed `AgentBusEvent`s for every meaningful transition: run started, iteration begun, checkpoint created, tool call dispatched, tool result returned, agent paused, agent canceled, plan requested, plan approved, error thrown. On top of raw event fan-out, the bus offers three kernel-grade primitives:

- **`CircuitBreaker`** (`bus/breaker.ts`) closes the bus to a flapping agent. If an agent's run keeps failing, the breaker trips and prevents retry storms. Configurable failure threshold and reset timeout.
- **`FileLockManager`** (`bus/lock.ts`) holds locks on files across concurrent agents. A child cannot acquire a lock its parent or sibling already holds. Acquisition timeout is enforced.
- **`EditOwnershipTracker`** (`bus/ownership.ts`) records which run last claimed ownership of a path, emits events on contention, and lets a HITL layer decide who wins. When two agents try to edit the same file, one of them is told to wait or re-plan.

These exist because the moment you have more than one agent running in parallel against a shared filesystem, you need the kernel to arbitrate. Most frameworks either do not have parallelism or leave it to user space; Namzu treats it as a first-class kernel concern.

### 3. Process Lifecycle: Manager (`manager/`)

`manager/agent/lifecycle.ts` is the `fork()` + `exec()` + `waitpid()` of the kernel. When a parent agent (say a `SupervisorAgent`) spawns a child, the lifecycle manager:

- Allocates a slice of the parent's token budget, timeout budget, and cost budget to the child
- Creates a child `AbortController` linked to the parent's
- Builds a child config via the agent definition's `configBuilder(factoryOptions)`
- Stamps the child with `parentAgentId`, `parentRunId`, `threadId`, and `depth`
- Registers the child task in an internal `TaskRegistry` keyed by `TaskId`
- Emits `agent_pending` on the bus with parent/child/depth metadata
- Forwards every child event to the parent's run listener so the supervisor sees what its subtree is doing

When the parent is cancelled — by HITL, by a limit breach, or by an external signal — `cancelAll(parentRunId)` walks the subtree and aborts every descendant. This is the Unix `SIGKILL` to a process group.

`manager/connector/` manages the lifecycle of external connectors (MCP servers, HTTP connectors). `manager/plan/lifecycle.ts` coordinates HITL plan review. `manager/run/persistence.ts` is the run-level persistence surface, and `manager/run/emergency.ts` is the emergency-save subsystem (see §9 below).

### 4. Scheduling: Router (`router/`), Execution (`execution/`), Limit Checker (`run/LimitChecker.ts`)

The router policy (`router/task-router.ts`) decides which model a task should go to. Compaction and summarization go to cheap models; coding and complex reasoning stay on expensive ones. Tiering is user-defined — you decide which models belong in which tier and what guidance the LLM gets about preferring tier-1 tools first.

The execution layer (`execution/base.ts`, `execution/local.ts`) is the concrete executor that invokes the provider, dispatches tool calls, and produces iteration results. Execution is pluggable; you could swap in a remote executor without touching the agent patterns above.

The limit checker (`run/LimitChecker.ts`) is the kernel scheduler's enforcement point. Every iteration it checks: have we exceeded the token budget? The cost budget? The wall-clock timeout? The iteration count? Has the user issued an abort? If any is true, it returns a typed hard-stop decision — `cancelled`, `token_budget_exceeded`, `timeout`, `max_iterations` — and the run ends cleanly with a stop reason recorded in its metadata.

### 5. The Runtime Query Path (`runtime/`)

`runtime/query/` is where one iteration of the agent loop actually happens. The pieces:

- `runtime/query/context.ts` assembles the request context: system prompt, persona, skills, tools, messages.
- `runtime/query/context-cache.ts` implements `ContextCache` — a hash-based system-prompt cache per thread. If the prompt inputs have not changed since last iteration, the cache returns the same text so provider-level prompt caching can hit.
- `runtime/query/prompt.ts` owns `PromptBuilder` — structured, segment-based prompt assembly (static segment vs dynamic segment) that plays well with provider prompt caches.
- `runtime/query/guard.ts` runs pre-dispatch guards on the request.
- `runtime/query/executor.ts` actually calls the provider and streams the result.
- `runtime/query/result.ts` normalizes the provider's response into the kernel's canonical shape.
- `runtime/query/checkpoint.ts` writes the iteration's checkpoint.
- `runtime/query/tooling.ts` bridges the iteration to the tool system, including progressive disclosure state.
- `runtime/query/iteration/` contains the iteration machinery.
- `runtime/query/plugin-hooks.ts` lets plugins observe and shape iterations.
- `runtime/query/events.ts` emits the typed events that feed the bus.

`runtime/decision/` (with `parser.ts` and `fallback.ts`) parses LLM decisions (tool calls vs final answer vs thinking vs advisory request) and falls back gracefully when the LLM returns malformed output.

### 6. Memory Management: Compaction (`compaction/`) and Store (`store/`)

Memory in the kernel is two systems cooperating.

**Working memory** is `compaction/`. When a thread's context approaches the model's window, the kernel does not truncate. It runs the `structured` compaction manager (default in `compaction/managers/structured.ts`, with `slidingWindow.ts` and `null.ts` as alternatives), which incrementally extracts `task / plan / files / decisions / failures` from the message stream into a typed `WorkingState`. The extractor (`compaction/extractor.ts`), verifier (`compaction/verifier.ts`), and serializer (`compaction/serializer.ts`) together produce compact markdown that replaces old messages. The agent keeps context awareness at a fraction of the token cost. `compaction/dangling.ts` handles partial tool-call streams that could otherwise corrupt the conversation state.

**Long-term memory** is `store/memory/`. The `MemoryIndex` (with `InMemoryMemoryIndex` as the default and a disk-backed variant) stores typed `MemoryIndexEntry` records, searchable by free-text query, tag set, and status filter. It persists to disk atomically. There is no required vector database — the default is good-old tag and text search. You can layer an embedding-backed index on top if you want, but the kernel does not assume it.

Alongside memory, `store/` has sibling stores for every kernel concept: `store/run/` (runs, iterations, checkpoints), `store/conversation/` (threads and messages), `store/activity/` (activity log), `store/task/` (task registry), and an in-memory generic `InMemoryStore` for tests and ephemeral workloads.

### 7. The Capability System: Tools (`tools/`) and Registry (`registry/`)

Tools in Namzu are first-class typed values, not JSON schemas you have to keep in sync with a handler somewhere else. `defineTool()` takes a Zod `inputSchema`, a Zod `outputSchema` (optional), and an `execute` function. It also takes **declarations** the kernel uses for routing and safety:

- `category` — e.g. `network`, `filesystem`, `compute`, `memory`.
- `permissions` — e.g. `network_access`, `write_filesystem`. Enforced at dispatch time.
- `readOnly` — predicate over input; tools that only read get different treatment by the verification gate and tool tiering.
- `destructive` — boolean flag that triggers HITL approval when true.
- `concurrencySafe` — whether two concurrent runs can invoke this tool with no interference.

`tools/builtins/` ships file I/O, shell, and glob-search tools. `tools/advisory/`, `tools/memory/`, `tools/task/`, and `tools/coordinator/` ship kernel-facing tools that let agents consult advisors, query memory, coordinate siblings, and manage their task registry from inside the agent loop.

**Progressive disclosure** is unique to Namzu. Tools exist in three states — `deferred`, `activated`, `suspended`. The LLM does not see the full tool catalog; it sees the current active set plus a searchable summary of deferred tools. When it needs something specific, it activates it; when it is done, it suspends it. This keeps the context window focused, reduces hallucinated tool calls, and lets a single agent work across dozens of tools without drowning in a prompt.

**Tool tiering** teaches the LLM a cost hierarchy. You define tiers ("tier-1: local", "tier-2: fast remote", "tier-3: expensive API"), each with its own guidance template, and the kernel instructs the LLM to prefer lower tiers first. Unlike hardcoded approaches, every label, priority, and template is yours.

Registries (`registry/`) are the kernel's object tables. `registry/tool/` is the canonical tool catalog. `registry/agent/` holds agent definitions (the thing you can `AgentManager.spawn()`). `registry/connector/` holds connector catalogs. `registry/plugin/` holds plugins. `ManagedRegistry` is the shared base class with tenant scoping.

### 8. The Decision Layer: Verification Gate (`verification/`)

Before any tool call leaves the kernel, it goes through `verification/gate.ts`'s `VerificationGate`. Think of it as the kernel's seccomp — a rule-based decision layer that says *allow*, *deny*, or *ask*.

Built-in rules:

- **`allow_read_only`** — if the tool's `readOnly(input)` returns true, allow.
- **`deny_dangerous_patterns`** — if the input matches any pattern from `DANGEROUS_PATTERNS` (shell injection, common exfiltration signatures, etc.), deny.
- **Custom regex rules** — per-tenant, per-agent, or global.

The `ask` decision hands control to the HITL layer. The verification gate is the kernel layer that makes "destructive tool requires approval" a policy, not a user-space convention.

Verification is intentionally separate from the sandbox: verification is the *decision*, sandbox is the *enforcement*. If a rule fails to deny and a call somehow gets through, the sandbox is still there to contain the damage. Defense in depth, kernel-style.

### 9. Durability: Checkpoints and Emergency Save

The kernel assumes processes crash. Two layers make sure that when they do, you do not lose the run.

**Checkpoints** (`store/run/disk.ts`) are atomic per-iteration snapshots. Each `IterationCheckpoint` captures the run state at a super-step boundary — messages, working state, tool-call state, usage, cost, iteration index. Writes are atomic via write-temp-rename (Convention #8). You can read them, list them, and delete them. A future `Run.replay(runId, { fromCheckpoint })` API will build on top of this; the storage is already there.

**Emergency save** (`manager/run/emergency.ts`) is the kernel's core-dump. `EmergencySaveManager` installs handlers for SIGINT and SIGTERM. When the process is dying, every active run gets its `toEmergencySnapshot()` flushed atomically to an `emergency/` directory. On the next boot you can inspect or resume the saved state. There is no reliance on the user remembering to catch signals; the kernel does it.

Together these give Namzu durable execution without requiring a database. Runs resume across crashes, across reboots, across graceful shutdowns.

### 10. Retrieval-Augmented Generation: RAG (`rag/`)

RAG is a full kernel subsystem, not a bolt-on. The pipeline:

- `rag/chunking.ts` — text chunking strategies (configurable by `ChunkingConfig`).
- `rag/embedding.ts` — the `EmbeddingProvider` abstraction. Providers are BYOK and swappable.
- `rag/ingestion.ts` — end-to-end ingest: document → chunks → embeddings → vector store.
- `rag/vector-store.ts` — the `VectorStore` interface, tenant-scoped via `TenantId`. Bring your own backend (pgvector, Pinecone, an in-memory impl for tests).
- `rag/knowledge-base.ts` — a named collection of documents with metadata and config.
- `rag/retriever.ts` — the retrieval query path with configurable top-k, threshold, and reranking.
- `rag/context-assembler.ts` — turns retrieval hits into prompt-ready context windows.
- `rag/rag-tool.ts` — a first-class tool your agent can invoke, not an external integration.

RAG lives in the kernel because retrieval is a capability every non-trivial agent needs. Making you wire it up from plugins every time was not the right default.

### 11. Skills (`skills/`)

Skills are disclosure-tiered capability bundles distinct from tools. A skill is a named body of knowledge, workflow, or policy that the agent can load on demand. `skills/loader.ts` reads them from disk; `skills/registry.ts` holds the active catalog; each skill has a `SkillDisclosureLevel` that decides when the LLM sees it (always visible, searchable-on-demand, explicit-activation-only). Skills and tools together form the two axes of an agent's capability surface.

### 12. Personas (`persona/`)

Personas describe who an agent is. `persona/assembler.ts` loads them from YAML and composes them with inheritance: a base `researcher` persona defines identity, expertise areas, output format, and reflexes; an `ml-researcher` child merges a single field (`expertise: [...base, 'ML', 'PyTorch']`) and inherits everything else. The assembler produces a typed `AgentPersona` that flows into the prompt as a structured segment (not a string concatenation, not a template hack), so prompt-cache-friendliness is preserved.

Personas are code-defined (YAML files in your repo). There is no database, no admin UI, no runtime mutation. That is deliberate: your agent's identity belongs in version control.

### 13. Advisory System (`advisory/`)

An advisor is a specialized assistant a running agent can consult mid-execution. The main agent is solving a task; halfway through it hits a decision it is not confident about, or a domain it wants a second opinion on. It fires an advisory request with context; the advisory layer evaluates triggers, routes to the right advisor, executes on a (possibly different) provider, and returns a structured answer the main agent can act on.

Pieces:

- `advisory/registry.ts` — `AdvisorRegistry`, the catalog of available advisors keyed by domain.
- `advisory/evaluator.ts` — `TriggerEvaluator`, decides whether an advisory should fire given context and config.
- `advisory/executor.ts` — `AdvisoryExecutor`, runs the advisor, collects its output, and feeds it back.
- `advisory/context.ts` — `AdvisoryContext`, the payload passed to advisors.

Unlike Anthropic's advisor tool (Claude-only, single advisor), Namzu's is **provider-agnostic** and **multi-advisor**: put a security advisor on Bedrock, an architecture advisor on OpenRouter, a legal advisor on Anthropic, and the agent decides who to consult. This is one of the things that most cleanly separates Namzu from the pack.

### 14. Human-in-the-Loop (`types/hitl/`, `manager/plan/lifecycle.ts`, `types/decision/`)

HITL is structured, not just a "pause and wait for input" hook. The kernel defines typed decision contracts: the LLM produces a plan, the plan can be approved / edited / rejected, approval can be per-tool with explicit destructiveness acknowledgment, rejection can carry feedback that re-enters the loop as a new iteration. The plan lifecycle has its own manager so that pending plans persist across checkpoint resumes. The verification gate's `ask` decision routes into this same HITL layer.

The kernel does not render a UI for this — it emits events and exposes a typed API so the UI layer you choose can render them however you like.

### 15. Providers (`provider/`)

An LLM provider implements a narrow interface: given a typed request, return a typed response (streaming or not) and propagate normalized usage, cost, and cache telemetry. Today `provider/openrouter/` and `provider/bedrock/` are in the box; adding another vendor is adding one directory. `provider/telemetry/` normalizes provider-specific response fields (OpenRouter's `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_discount`, Bedrock's equivalents) into a single kernel-wide telemetry shape.

`ProviderFactory` is the single entry point. Every run chooses its provider by name; the provider object itself is stateless enough to be shared across runs.

### 16. Connectors (`connector/`)

A connector is how an agent reaches external systems. `connector/BaseConnector.ts` is the abstract base; `connector/mcp/` implements MCP connectors in both `stdio` and `http` transports with a `client.ts` and an `adapter.ts` that turns MCP tools into Namzu `ToolDefinition`s; `connector/builtins/` ships the built-in connectors (HTTP, shell, etc.); `connector/execution/` handles connector-level execution concerns. Plugin contributions can register connectors at runtime.

### 17. Prompt Cache Integration

The kernel takes prompt caching seriously because token cost is the number-one production constraint for agents. `runtime/query/context-cache.ts` maintains a per-thread `ContextCache` that hashes the inputs (system prompt + persona + skills + tools + base prompt) and only rebuilds when the hash changes. When the provider supports cache controls (OpenRouter's `cacheControl` parameter today, Anthropic and Bedrock cache headers in progress), the kernel attaches them, and the response's cache telemetry (`cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_discount`) flows back into the run's usage metrics.

This is why `PromptBuilder` splits a request into static and dynamic segments: the static segment is the cache target, and the kernel does the bookkeeping to keep it stable across iterations so the cache actually hits.

### 18. Vault (`vault/`)

The vault holds BYOK credentials and arbitrary secrets. `InMemoryCredentialVault` is the default backend; the `CredentialVault` interface lets you plug in your own. Credentials are tenant-scoped — tenant A cannot see tenant B's keys. Tools, providers, and connectors resolve credentials through the vault rather than reading environment variables directly, so you can rotate without redeploying and you can audit who accessed what.

### 19. Telemetry (`telemetry/`)

OpenTelemetry-native. `telemetry/attributes.ts` defines the canonical attribute keys; `telemetry/metrics.ts` defines the kernel's metrics surface. Every iteration, every tool call, every provider call emits spans with consistent attributes: `run.id`, `thread.id`, `agent.id`, `tenant.id`, `tool.name`, `provider.name`, `model`, `usage.input_tokens`, `usage.output_tokens`, `usage.cached_tokens`, `cost.usd`. Wire your existing OTel collector, or pipe to LangSmith / Langfuse / Braintrust via their OTel adapters.

### 20. Plugin System (`plugin/`)

Plugins extend the kernel at runtime. A plugin manifest declares what it contributes (tools, MCP servers, advisors, connectors), and the kernel's `plugin/loader.ts` reads manifests from disk, `plugin/resolver.ts` namespaces everything safely, and `plugin/lifecycle.ts` hooks plugin init / shutdown into the kernel's own lifecycle. Plugins can subscribe to iteration hooks via `runtime/query/plugin-hooks.ts` and shape what the LLM sees.

Plugins are how a community ecosystem grows around the kernel without the kernel having to ship batteries for every use case.

### 21. Gateway (`gateway/`)

`gateway/local.ts` is the local-process gateway — a thin translation layer between an external caller (HTTP, WebSocket, stdin, another agent over A2A) and the kernel's run API. Put a real HTTP server in front of it and you have an agent service; wrap it in a CLI and you have an agent shell. The gateway is where your application layer plugs into the kernel.

### 22. Agent Patterns (`agents/`)

Four patterns ship in the kernel. They are not mandatory — you can write your own `AbstractAgent` subclass for custom loops — but these are the shapes most real workloads want.

- **`ReactiveAgent`** — the canonical agent loop. Prompt → LLM → tool call(s) → iterate → stop. Handles token budget, cost limit, timeout, max iterations, HITL injection, progressive tool disclosure, compaction, and checkpointing automatically.
- **`PipelineAgent`** — deterministic sequential steps. Each step is a typed function; output of step N is input of step N+1. Rolls back on failure. Useful for ETL, RAG ingestion, multi-stage document processing.
- **`RouterAgent`** — an LLM classifies the input and delegates to the best-suited agent from a configured set of candidates, with a fallback. Useful for intent routing in customer support, dispatcher bots, and multi-expert systems.
- **`SupervisorAgent`** — a coordinator that spawns and orchestrates a set of specialized child agents. Tracks the full parent/child/depth hierarchy, aggregates results, handles partial failures, and honors the shared budget tracker.

All four sit on top of the same lifecycle manager, the same limit checker, the same bus, the same verification gate. Switching patterns does not change what safety or durability the kernel provides.

### 23. Multi-Tenant Isolation

Every registry, every store, every vault is tenant-scoped. `TenantId` is a branded ID threaded through the kernel's types. A run for tenant A cannot accidentally read tenant B's knowledge base, invoke tenant B's tools, or resolve tenant B's credentials. This is not a feature you turn on — it is the default, and a single-tenant setup is just a special case.

### 24. Thread / Run Separation

A **thread** is a conversation: a series of user ↔ assistant messages, possibly spanning many sessions, probably spanning many days. A **run** is a single execution pass: an input, iterations, tool calls, usage, cost, result. One thread has many runs. Most frameworks conflate the two; Namzu keeps them explicit, with separate stores, separate IDs, and separate serialization. Multi-turn dialogs carry only the context the kernel thinks matters (via compaction), and run traces stay auditable without drowning in prior-turn tool chatter.

---

## Install

```bash
npm install @namzu/sdk
```

Requirements: Node ≥ 22, TypeScript strict mode, ESM.

## Quick Start

```typescript
import { defineTool, ProviderFactory, ReactiveAgent, ToolRegistry } from '@namzu/sdk'
import { z } from 'zod'

const searchWeb = defineTool({
  name: 'search_web',
  description: 'Search the web for information',
  inputSchema: z.object({ query: z.string() }),
  category: 'network',
  permissions: ['network_access'],
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  execute: async ({ query }) => {
    const r = await fetch(`https://api.search.com?q=${query}`)
    return { success: true, output: await r.text() }
  },
})

const provider = ProviderFactory.createProvider({
  type: 'openrouter',
  apiKey: process.env.OPENROUTER_KEY!,
})

const tools = new ToolRegistry()
tools.register(searchWeb)

const agent = new ReactiveAgent({
  id: 'researcher',
  name: 'Research Assistant',
  version: '1.0.0',
  category: 'research',
  description: 'Finds and synthesizes information',
})

const result = await agent.run(
  { messages: [{ role: 'user', content: 'Summarize the latest LLM benchmarks' }], workingDirectory: process.cwd() },
  { model: 'anthropic/claude-sonnet-4-20250514', tokenBudget: 8192, timeoutMs: 600_000, provider, tools },
)
```

That is a complete, sandbox-isolated, checkpointed, telemetrized agent run with prompt caching, progressive tool disclosure, structured compaction, and emergency save all wired in by default. Those are not features you enable; they are how the kernel runs.

Examples for `PipelineAgent`, `RouterAgent`, and `SupervisorAgent` are in `src/agents/`.

---

## Design Principles

Five choices shape every decision in the kernel.

**No workarounds. Fix at the root.** When something is wrong, we fix the pattern, not the symptom. A subtle bug in the lifecycle manager means the lifecycle manager changes — we do not paper over it in the agent pattern that calls it.

**Type safety is the foundation.** Every resource ID is branded (`RunId`, `ThreadId`, `TaskId`, `TenantId`, `AgentId`, `ToolId`, `MemoryId`, `ChunkId`...). Every discriminated union has exhaustiveness checks. Every public API has Zod-validated inputs at the boundary. The TypeScript compiler is not a formality; it is the first line of defense.

**Deny by default. Fail fast.** Sandboxes deny file I/O by default. Verification gates deny tool calls by default unless a rule allows them. Limit checkers fail the run the moment a budget is breached. Configuration errors throw at boot, not at the 90-minute mark of a long-running job.

**Dependency direction is sacred.** `contracts` knows nothing about `sdk`. `sdk` knows nothing about `agents` or `api`. Circular dependencies are a compile error, not a code-review suggestion. This is what keeps the kernel's interface surface small even as its guts grow.

**Convention over surprise.** Every new feature follows a shared pattern language — Registries, Managers, Stores, Runs, Bridges, Providers. You read one subsystem, you can navigate the next one.

---

## The Agent Event Protocol (AEP)

The kernel's contract with the outside world is a typed, versioned event stream. Any UI, any shell, any observability tool subscribes to AEP and renders what it wants.

AEP flows over three transports:

- **Bus** (`bus/`) — in-process, for tightly-coupled consumers.
- **SSE** (`bridge/sse/mapper.ts`) — cross-process over HTTP, for web UIs and remote observers.
- **A2A** (`bridge/a2a/`) — cross-agent, for multi-agent meshes.

Every transport emits the same event shape. Event types include run lifecycle (`run_started`, `run_paused`, `run_completed`), iteration events (`iteration_started`, `checkpoint_created`), tool events (`tool_called`, `tool_result`), agent events (`agent_pending`, `agent_canceled`), plan events (`plan_requested`, `plan_approved`), advisory events, and error events. They carry consistent metadata: `runId`, `threadId`, `agentId`, `tenantId`, `timestamp`, `depth`, `parentRunId`.

AEP v1 is being finalized. Until the spec is stamped, treat the event shapes as semver-minor.

---

## What You Can Build

Namzu is not a toy. It is meant for real workloads.

**Personal and homelab.** A home-automation agent monitoring logs, restarting services, running health checks. A personal research agent feeding PDFs and notes through the RAG pipeline into a knowledge base, answering with citations from your own data. A code-review agent watching your repos, reviewing PRs with a `PipelineAgent` (extract diff → analyze → write review), and posting feedback automatically. A media organizer scanning your library, categorizing files, renaming based on metadata, deduplicating.

**Business and team.** A customer-support triage system where a `RouterAgent` classifies incoming tickets and delegates to specialized children (billing, technical, general), each with its own persona, tools, and knowledge base. A document-processing pipeline ingesting contracts, invoices, and reports through RAG, extracting key data, flagging anomalies, generating summaries, with HITL approval for anything destructive. An internal-ops bot that plugs into Slack, Jira, and your database over MCP. A compliance checker where a `SupervisorAgent` coordinates sub-agents each checking a different regulation, then aggregates results and routes flagged items through plan review.

**Platform and SaaS.** This is the shape Namzu was designed for from day one. Agent-as-a-Service — each customer gets isolated agents with their own BYOK keys, connector configs, and knowledge bases; tenant isolation is built in, not bolted on. An agent marketplace — agents are portable definitions (`info + tools + persona + skills`), publishable, deployable by any customer with their own keys, specializable through persona inheritance. Cross-organization workflows where agents from different companies discover each other via A2A agent cards and collaborate without a central authority.

---

## Quality Bar

On architectural fundamentals, Namzu scores at the top of open-source agent frameworks.

| Criterion | Namzu | LangChain/LangGraph | CrewAI | OpenAI Agents SDK | Vercel AI SDK |
|---|---|---|---|---|---|
| Type Safety | 9 | 5 | 7 | 7 | 9 |
| Modularity | 9 | 5 | 7 | 8 | 9 |
| Interface Segregation | 8 | 4 | 6 | 8 | 8 |
| Extensibility | 9 | 7 | 6 | 6 | 7 |
| Convention Consistency | 8 | 5 | 7 | 8 | 8 |
| Dependency Direction | 9 | 4 | 6 | 8 | 8 |
| **Overall** | **8.7** | **5.0** | **6.5** | **7.5** | **8.2** |

Scores are informed from public docs, community reports, and direct codebase analysis — not a definitive ranking. Where we know we have work to do: test coverage is not where the architecture deserves. Helping close that gap is the highest-leverage contribution today.

---

## Roadmap

Honest view. The kernel is already deep. The next three releases tighten the consumer surface, add the subsystems that are genuinely missing, and extend the driver model to new I/O shapes.

### v0.2 — Surface Polish (short, mostly wiring + docs)

- `Run.replay(runId, { fromCheckpoint })` API on top of the existing checkpoint store
- Memory promotion pipeline connecting compaction output to the indexed memory store via a Reflector persona
- **AEP v1 spec** — version and document the event shapes in `bridge/sse/mapper.ts`
- Public pattern docs for lifecycle, checkpoints, emergency save, budget / quota, verification gate, context cache, file ownership, and circuit breaker
- `ContextCache` generalized across providers (OpenRouter today → Anthropic, Bedrock next)

### v0.3 — New Subsystems (the four genuinely missing pieces)

- **Workflow / process-graph DSL** — typed `step / branch / parallel / loop / hitl` builder, durable on top of the existing checkpoint and lifecycle
- **Evaluation subsystem** — `Dataset` + `Scorer` + `Experiment` primitives with a `namzu eval run` CLI, model-graded / rule-based / statistical scorers, SCD-2 versioning
- **Content-level guardrails** — a second policy layer next to the verification gate, covering LLM I/O (PII, prompt injection, output schema, toxicity) with per-tenant and per-tool attachment
- **Semantic cache** and **prompt compression** as opt-in additions next to the existing `ContextCache`

### v0.4 — Drivers and I/O (extending the driver model)

- **Voice driver** — unified STT / TTS provider abstraction, duplex streaming, real-time speech-to-speech
- **Multimodal tool I/O** — MIME-typed binary handles for image, audio, and video inputs and outputs
- **Computer-use driver** — reference implementation with its own sandbox profile
- **Deterministic provider replay** — cassette pattern for eval and CI, separate from run-level checkpoints

### Explicitly out of scope (community or separate packages)

- `@namzu/react`, `@namzu/svelte`, `@namzu/vue` chat hooks
- Next.js / Hono / Cloudflare Workers adapters
- A dev studio playground (would consume AEP, lives in its own repo)
- A visual observability dashboard in the style of VoltOps or LangSmith

These are valuable — they belong on top of the kernel, not in it. Keeping the kernel's interface surface small is why the kernel can move fast.

---

## License and Vision

[FSL-1.1-MIT](./LICENSE.md). Every version becomes fully MIT two years after release.

The vision: an open, community-driven agent kernel that reduces systemic dependencies on proprietary platforms — so everyone can build, own, and run AI agents freely. Namzu works with any LLM provider through BYOK, runs in isolation without container orchestration, and surfaces a stable protocol so the application layer stays yours.

If that resonates, we would love your help. Bug reports, feature ideas, PRs, a kind word on your blog — all of it matters. The fastest way in is to pick a subsystem from `src/` that looks interesting, read its code, and open an issue or a PR.
