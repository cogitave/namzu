---
uid: namzu.sdk.architecture
title: The kernel in depth — thesis, subsystems and the event protocol
description: Architecture reference for @namzu/sdk: what the kernel is and deliberately is not, every subsystem from the sandbox boundary to multi-tenant isolation, the design principles the code is held to, and the agent event protocol a host consumes.
type: Explanation
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-19T00:00:00Z
lastReviewed: 2026-08-19
resource: packages/sdk/src/public-runtime.ts
tags: [sdk, architecture, explanation]
---

# The kernel in depth — thesis, subsystems and the event protocol

## The Thesis

Most "agent frameworks" today are really application frameworks. They ship chat UIs, picking UI layouts, batteries-included hosted dashboards, vendor-specific fast paths, and integration drivers for a handful of databases. You get something you can demo in an hour, and three months later you own a stack where the same framework dictates your frontend, your database, your observability, and your model vendor.

We think agent software should be layered the way an operating system is. At the bottom there needs to be a **kernel**: something to isolate processes, schedule tool calls, manage memory pressure, propagate signals across a call tree, persist checkpoints so a run can resume after a crash, mediate inter-process communication, and produce an auditable event stream. Above the kernel there is user space — shells, editors, IDEs, voice gateways, web front-ends. The kernel does not care which shell you pick; the shell cannot break the isolation the kernel provides.

**Namzu is the kernel.** It runs agents the way an operating system runs processes. It does not render UI, it does not pick your database, it does not favor one LLM vendor. It gives you a surface — typed, versioned, documented — that any UI, any storage backend, and any model can plug into. The surface is small and stable; the guts underneath are deep.

---

## What Namzu Is

Namzu is a single-process TypeScript kernel with the following responsibilities:

- **Process execution and isolation.** Tools run outside the host process, under OS-level containment whose enforced controls vary by tier — and the kernel states per tier which of filesystem, network and process isolation it actually enforces, refusing to start a run whose required control the host cannot supply rather than silently downgrading it. No container runtime, no daemon, no sidecar. See [The Boundary](#1-the-boundary-sandbox-sandbox) for the table.
- **Agent lifecycle.** Parent/child agent spawn with depth tracking, budget splitting, and causal trace linkage. A supervisor can fork a subtree of agents and get their results back, with each child isolated from its siblings.
- **Scheduling.** Per-run token, cost, wall-clock, and iteration budgets. Limit checker, task router (cheap model for compaction, expensive for coding), tool tiering (LLM learns to prefer cheaper tools first).
- **Signals.** `AbortController` tree spanning parent and children. `cancel(taskId)` and `cancelAll(parentRunId)` propagate. Runs can be paused and resumed, aborted cleanly, and emit lifecycle events for every transition.
- **Memory management.** Working memory via structured compaction to a typed `WorkingState`. Long-term memory via an indexed, tag/query/status-searchable store with disk persistence. No vector database required by default.
- **Durability.** Atomic per-iteration checkpoints, an opt-in emergency core-dump on SIGINT/SIGTERM (`emergencySave: true` — a library must not seize a host process termination path by default), and separate storage for runs, sessions, session-owned completion goals, topic state and objectives, activities, memories, and tasks.
- **IPC.** Native A2A (agent-to-agent) and MCP (Model Context Protocol) — both client and server, one SDK. An internal event bus with circuit breakers, file lock manager, and edit ownership tracking so concurrent agents do not stomp on each other.
- **Capability system.** Tools are first-class, typed, permissioned, and progressively disclosed. The LLM does not see the full tool catalog; tools start deferred, get activated on demand, and can be suspended. Each tool declares `readOnly`, `destructive`, `concurrencySafe`, `permissions`, `category`.
- **Syscall filtering.** Every tool call goes through a verification gate — allow / deny / ask, with built-in rules for read-only allowlist and dangerous pattern deny-list, plus custom regex rules. This is separate from sandbox isolation; it is the decision layer, the sandbox is the enforcement layer.
- **Retrieval-augmented context (RAG).** A full pipeline: chunking, embedding providers, ingestion, knowledge base storage, vector store, retriever, context assembler, and a first-class `rag-tool`.
- **Skills.** Disclosure-tiered capability bundles that the agent can load on demand, distinct from tools.
- **Personas.** YAML-defined identity, expertise, reflexes, and output format with inheritance — specialize a base persona by merging a single field, no prompt concatenation.
- **Advisory system.** Mid-execution consultation with specialized advisors. Provider-agnostic: put a security advisor on Bedrock, an architecture advisor on OpenRouter, and let the main agent decide when to consult whom.
- **Human-in-the-loop.** Structured plan review, per-tool approval with destructiveness flags, typed decision contracts, checkpoint/resume across sessions.
- **Plugin system.** Lifecycle-hooked plugin loader with MCP contributions, tool contributions, and manifest-driven resolution.
- **Multi-tenant isolation from day one.** Connector registries, vaults, config, and stores are tenant-scoped. Two organizations can share a process without cross-contamination.
- **Provider abstraction.** Seven drivers ship today, each its own package installed only if you use it, plus a scriptable mock pre-registered in the kernel. The `LLMProvider` interface is narrow enough that adding another is an afternoon. BYOK everywhere, no hidden hot paths for any vendor. Every run also applies a finite per-chunk silence bound inside retry and fallback, so a request that opened and then stopped producing cannot hold the lifecycle forever.
- **Telemetry.** OpenTelemetry-native spans and metrics. Cost accounting (input tokens, output tokens, cached tokens, cache write tokens, cache discount) flows from the provider into per-run, per-tenant rollups.
- **Prompt cache integration.** Hash-based system-prompt caching by agent and project, integrated with provider cache controls, plus cache telemetry in every run.
- **Vault.** BYOK credentials and secrets, tenant-scoped, pluggable backend.
- **Topic / Run separation.** A topic can outlive the sessions and runs that work on it; a run remains one execution pass with its own events, checkpoints, usage, and result.

Every one of those bullets points at code that exists today in `src/`. The architecture is deep even where the surface is quiet.

## What Namzu Is Not

Equally important for scoping expectations:

- **Not a chat SDK.** No front-end framework bindings, no generative UI components, no ready-made chat hook. Your UI framework is your choice; the kernel hands you a typed event stream.
- **Not a hosted service.** There is no dashboard, no Namzu Cloud, no billing page. You run it in your own process.
- **Not a deployment adapter.** No web-framework or edge-runtime plumbing in the kernel. That belongs in separate packages or your own infra code.
- **Not a dev studio.** No bundled playground UI. A playground that consumes the kernel's event protocol could exist as a separate tool; it would not live inside `@namzu/sdk`.
- **Not a vector database.** RAG ships with a pluggable `VectorStore` interface; the kernel embeds no vector engine of its own. Bring your own.
- **Not an LLM router service.** Task routing is an in-process policy, not a hosted service.
- **Not a prompt management UI.** Personas are code-defined (YAML files in your repo), not database rows behind a web form.

The goal of that list is not to be minimal — the kernel is plenty rich. The goal is to keep the kernel's **interface surface** small and stable so the layers above can move fast without breaking what is underneath.

---

## What the Kernel Provides

Category by category, with the symbol that implements it. This list
exists to be checked against the source, not against anybody else.

| Capability | What it is here |
|---|---|
| Process sandbox (OS-level) | Seatbelt profiles or mount + PID namespaces, refusing when a requested control cannot be enforced |
| Multi-tenancy | Tenant, project, topic, session and run are separate identities from day one, not a field added later |
| Sub-agent spawn | Parent/child with depth, budget and a shared pool the parent debits |
| Signal propagation | One abort tree; cancelling a parent tears down every descendant |
| Checkpoint and resume | Per iteration, versioned, written atomically, with the trace context to rejoin |
| Emergency save | Opt-in snapshot on a fatal signal, replayable through the ordinary restore path |
| Resource quotas | Token, cost and wall-clock caps per run and per child |
| Prompt cache | Cache anchors placed by the runtime and reported in telemetry |
| Topic ↔ Run separation | A topic outlives the sessions and runs that work on it |
| Session goal | Exact-revision completion state owned and tenant-authorized by one durable session |
| Agent-to-agent protocol | Client and server, in the kernel |
| Model Context Protocol | Client and server, in the kernel |
| Retrieval | A full pipeline in the kernel rather than an integration |
| Persona inheritance | Merge-based, declared in YAML |
| Advisory | Multiple advisors, each on whichever provider suits it |
| Context compaction | Structured working state, safe trim points, pinned messages |
| Tool tiering | Cost-aware, author-defined |
| Task routing | Per-task model with fallback chains |
| Progressive tool disclosure | Deferred, active and suspended tool states |
| Tool-call verification | Allow, deny or ask, with custom gates |
| File ownership | Edit locking so two concurrent writes cannot clobber |
| Circuit breakers | On the internal bus |
| Skills | Disclosure-tiered, separate from tools |
| Plugins | Install, enable, disable, with a hook lifecycle |
| Vault / BYOK | Tenant-scoped |
| Telemetry | OpenTelemetry natively, with GenAI conventions |
| Provider lock-in | None; the driver is a config choice |
| Provider liveness | Five-minute stream-silence default, transport abort, retry then fallback |

---

## Architecture in Depth — Every Subsystem

Every folder under `src/` maps to a traditional OS concept. This section walks them one by one, in the order a request actually flows.

### 1. The Boundary: Sandbox (`sandbox/`)

Tools do not execute in the host process. What that buys you **depends on the tier the host can supply, and the tiers do not all enforce the same controls** — so the kernel keeps an honest table rather than a promise (`sandbox/isolation.ts`):

| Environment | Filesystem | Network | Process |
|---|---|---|---|
| `linux-bwrap` | yes | yes | yes |
| `macos-seatbelt` | yes | yes | yes |
| `linux-namespace` | **no** | yes | yes |
| `basic` | no | no | no |

`SANDBOX_ENVIRONMENTS` holds that order — strongest first — and detection walks it. It is exported because the list had been spelled out by hand wherever it was needed, and the first tier added after those copies were written broke one of them.

`linux-namespace` reports `filesystem: false` deliberately. It unshares the mount namespace but never remounts anything, so the child still sees the whole host filesystem — a private mount table is not confinement, and saying otherwise here would be the exact defect the table exists to prevent.

`linux-bwrap` is the tier that does remount, and so is the first on that platform entitled to claim the control. It builds a mount table holding the sandbox root read-write, the system paths a binary needs read-only, private `/proc`, `/dev` and `/tmp`, and nothing else — a host path is **absent** rather than unreadable, which is the difference between a boundary and a permission bit. The interpreter's own prefix is bound read-only, because a runtime installed outside the distribution's packages is otherwise not there at all and the failure reads as a broken command rather than as the sandbox working.

Detection runs the real confinement rather than asking a binary its version: a host with the tooling present and unprivileged user namespaces disabled falls through to the weaker tier instead of claiming a control it cannot deliver.

This matters because the failure it guards against is silent. If a run requires a control the host cannot enforce, `assertIsolation` **refuses to start it** rather than proceeding at a weaker tier: a security control that is accepted and then quietly not applied is worse than one that was never offered, because the caller stops looking. Use `isolationOf`, `missingIsolation` and `describeIsolation` to ask what you are actually getting before you rely on it.

The `SandboxProvider` abstraction (`sandbox/factory.ts`, `sandbox/provider/`) lets you supply a stronger provider without touching the rest of the kernel. The kernel enforces memory, timeout, and max-process limits on top of whatever the sandbox gives you.

Background jobs are a separate host-process capability, not a mode of sandbox execution. `BackgroundJobRegistry` can be supplied to an unsandboxed run, where `bash` may start work that outlives its tool call and the run later tears that work down. A run that creates a sandbox does not expose that host registry in `ToolContext`, and `bash run_in_background` refuses with that reason. Otherwise changing only `run_in_background` would move the same command from `sandbox.exec()` to a host child process and turn a scheduling option into an isolation bypass. A sandboxed persistent process requires a backend that owns both its lifetime and its confinement; the host registry does not claim to be one.

The same boundary applies to pseudo-terminals. `LocalSandboxProvider` does not implement `Sandbox.openTerminal`: setting a host PTY's working directory to `rootDir` neither applies the provider's isolation tier nor makes `destroy()` kill and await its descendant tree. The optional method is deprecated while its removal observes the public deprecation window; any external backend that still implements it must provide both guarantees. The exported `loadPty` and `openTerminalWith` utilities are host-scoped primitives, not sandbox or lifecycle owners. A future persistent-terminal service needs an owner-scoped registry, a process substrate that owns complete session teardown, and confinement applied to the exact argv before spawn.

### 2. Interprocess Communication: Bridge (`bridge/`) and Bus (`bus/`)

Two layers here, with different jobs.

**Bridge** is cross-process and cross-agent communication. The `bridge/a2a/` folder speaks the Agent-to-Agent protocol: your agents can publish agent cards describing their capabilities and can discover and invoke other agents' capabilities. The `bridge/mcp/` folder speaks the Model Context Protocol, both as a client (consume MCP servers as tools) and as a server (expose your Namzu tools to any MCP-speaking agent). The `bridge/sse/` folder contains the event mapper that turns in-process events into Server-Sent Events for any consumer on the other side of HTTP. What a *connector* contributes to the tool system lives with the connector, under `connector/tools/`, not here — `bridge/` is protocol boundaries.

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
- Stamps the child with `parentAgentId`, `parentRunId`, `topicId`, and `depth`
- Registers the child task in an internal `TaskRegistry` keyed by `TaskId`
- Emits `agent_pending` on the bus with parent/child/depth metadata
- Forwards every child event to the parent's run listener so the supervisor sees what its subtree is doing

When the parent is cancelled — by HITL, by a limit breach, or by an external signal — `cancelAll(parentRunId)` walks the subtree and aborts every descendant. This is the equivalent of signalling a whole process group.

`manager/connector/` manages the lifecycle of external connectors (MCP servers, HTTP connectors). `manager/plan/lifecycle.ts` coordinates HITL plan review. `manager/run/persistence.ts` is the run-level persistence surface, and `manager/run/emergency.ts` is the emergency-save subsystem (see §9 below).

### 4. Scheduling: Router (`model-router/`), Execution (`execution/`), Limit Checker (`run/LimitChecker.ts`)

The router policy (`model-router/task-router.ts`) decides which model a task should go to. Compaction and summarization go to cheap models; coding and complex reasoning stay on expensive ones. Tiering is user-defined — you decide which models belong in which tier and what guidance the LLM gets about preferring tier-1 tools first.

The execution layer (`execution/base.ts`, `execution/local.ts`) is the concrete executor that invokes the provider, dispatches tool calls, and produces iteration results. Execution is pluggable; you could swap in a remote executor without touching the agent patterns above.

The limit checker (`run/LimitChecker.ts`) is the kernel scheduler's enforcement point. Every iteration it checks: have we exceeded the token budget? The cost budget? The wall-clock timeout? The iteration count? Has the user issued an abort? If any is true, it returns a typed hard-stop decision — `cancelled`, `token_budget_exceeded`, `timeout`, `max_iterations` — and the run ends cleanly with a stop reason recorded in its metadata.

### 5. The Runtime Query Path (`runtime/`)

`runtime/query/` is where one iteration of the agent loop actually happens. The pieces:

- `runtime/query/context.ts` assembles the request context: system prompt, persona, skills, tools, messages.
- `runtime/query/prompt-cache.ts` implements `PromptCache` — a hash-based system-prompt cache keyed by the agent and project that own it. If the prompt inputs have not changed since the last iteration, the cache returns the same text so provider-level prompt caching can hit.
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

**Working memory** is `compaction/`. When a topic's carried conversation approaches the model's window, the kernel does not truncate. The runtime query's `structured` compaction phase incrementally extracts `task / plan / files / decisions / failures` from the message stream into a typed `WorkingState`; `sliding-window` is the deliberately simpler reducer alternative and `disabled` opts out. The older `StructuredCompactionManager` class is a deprecated parallel implementation, not the strategy the runtime drives. The extractor (`compaction/extractor.ts`), verifier (`compaction/verifier.ts`), and serializer (`compaction/serializer.ts`) together produce compact markdown that replaces old messages. The agent keeps context awareness at a fraction of the token cost. `compaction/dangling.ts` handles partial tool-call streams that could otherwise corrupt the conversation state.

A pass also runs **when a host asks for one**, not only when a threshold fires: `compactNow` summarises a whole conversation and `compactRegion` collapses a span the caller chose, both returning a replacement history rather than editing the input. These host-triggered paths first extract structured state from the span they replace; a header with an empty body is not a summary. Their summary message is retained because no run-scoped manager exists outside the query to prove it has reconstructed equivalent state. A later pass may add a newer replaceable summary, but it cannot erase that retained record. When LLM verification is enabled, the host-callable paths apply the SDK's finite provider-stream idle bound and accept `signal` plus `streamIdleTimeoutMs`; malformed liveness config and pre-cancelled work are refused before even a no-op is reported. In-loop verification instead reuses the query's already-composed `fallback(retry(idle(provider)))` chain and forwards only the run signal, so Stop reaches transport without an outer idle timer miscounting retry backoff.

Starting a fresh query rebuilds the current static and dynamic prompt, so it still rejects arbitrary system messages from prior history. Two system-message forms are conversation state rather than an old prompt: a compacted-context summary and the working-memory artifact ledger. They are restored after the fresh prompt, and an inherited compaction summary is pinned before the first provider request. If that request overflows and automatic compaction runs, the inherited summary therefore reaches both the retry and the final run-message snapshot instead of disappearing at the second hop.

`CompactNowInput`, `CompactionResult`, and `CompactionVerificationOptions` are exported alongside the host-triggered functions — a function on the public surface whose parameter and return types are not on it forces its first caller to inline the shape, which is exactly what happened before they were.

A host that persists conversation messages can commit that returned history through the optional `SessionStore.replaceMessages`. The in-memory store replaces its projection directly; the disk store appends one replacement record to `messages.jsonl`, so the physical log stays append-only while subsequent reads see the complete replacement followed by later appends. One record is the transaction boundary — a crash cannot expose the first half of a compacted history. `isCompactionMessage` identifies the summary system message when a host restores its own transcript view.

That rule is now a CI step rather than a habit. `check-signature-types-exported.mjs` resolves every exported signature and fails when a type it names is declared in the package and not exported; its first run found twenty-eight, each the parameter or the result of a function that was already public.

**Long-term memory** is `store/memory/`. The `MemoryIndex` (with `InMemoryMemoryIndex` as the default and a disk-backed variant) stores typed `MemoryIndexEntry` records, searchable by free-text query, tag set, and status filter. It persists to disk atomically. There is no required vector database — the default is good-old tag and text search. You can layer an embedding-backed index on top if you want, but the kernel does not assume it.

Alongside memory, `store/` has sibling stores for the kernel's durable concepts: `store/run/` (runs, events, checkpoints and surviving messages), `store/session/` (projects, topics, sessions and summaries), `store/goal/` (same-session completion state), `store/topic/` (mutable topic state and multi-round objectives), `store/activity/`, `store/attachment/`, `store/feedback/`, and `store/task/`. Topic state, objectives, session goals, and message feedback use exact revisions; the disk implementations publish immutable revision commits so one writer wins even across processes. See [Session-owned completion goals](session-goals.md), [Durable topic revisions](topic-store-revisions.md), and [Durable message-feedback revisions](feedback-store-revisions.md) for their ownership, filesystem, compatibility, and upgrade contracts.

An active session goal is state, not a scheduler. The store proves which durable
session owns the objective and atomically admits a finite round; a separate
process-local activation says whether this host may spend another one. Exact
run authority makes the goal tools reachable only inside that admitted round.
The host remains responsible for whole-application quiescence, human FIFO,
turn-evidence publication, persistence settlement, and the final ownership
check before provider creation. Keeping that driver outside persistence means
a restart or state read cannot become hidden work.

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

**Run evidence** has two durable halves: the event log and the message snapshot that survived compaction. `RunStore.readEvents()` reads the first; `RunStore.readMessages()` reads the second. A published message snapshot carries `throughEventSeq`, the exact durable event-log head it follows. `RunQuery.fullTranscript()` can therefore combine every `compaction_shed` record with the surviving messages without mistaking a snapshot left by an earlier pause for the current run. It refuses when the snapshot is missing, when an older raw-array snapshot has no verifiable boundary, or when its boundary does not match the log head. Missing is not treated as an empty conversation: a process may have written the terminal event and run metadata before crashing on message publication. `readRunMessagesIn(runDir)` provides the same non-creating disk read as `readRunEventsIn(runDir)` for hosts walking run directories directly.

Event-log read-back is tolerant by default: an incident viewer can still show
the intact records around one damaged line. A caller making a completeness claim
passes `{ integrity: 'strict' }` to `readEvents` or `readRunEventsIn`; a torn
final record, malformed event object, invalid sequence, or sequence gap then
refuses the read instead of being skipped. The two modes answer different
questions — “what evidence remains?” and “can I prove no event is missing?” —
and neither silently substitutes for the other.

**Emergency save** (`manager/run/emergency.ts`) is the kernel's core-dump. Pass `emergencySave: true` to `query()` and `EmergencySaveManager` installs handlers for SIGINT, SIGTERM and `uncaughtException`; when the process is dying the run's `toEmergencySnapshot()` is flushed atomically to an `emergency/` directory, and `replay({ fromCheckpoint: 'emergency' })` reads it back. The handlers are removed when the run settles.

It is **opt-in on purpose.** Attaching means calling `process.on(...)` with handlers that `process.exit()` — a library must not seize a host's termination path by default, and the manager is a singleton, so with concurrent runs the last one to attach would silently become the only one saved. Turn it on for a process that owns its run end to end (a CLI, a single-run worker); leave it off inside a server that has its own drain sequence.

Together these give Namzu durable execution without requiring a database. Runs resume across crashes, across reboots, across graceful shutdowns.

### 10. Retrieval-Augmented Generation: RAG (`rag/`)

RAG is a full kernel subsystem, not a bolt-on. The pipeline:

- `rag/chunking.ts` — text chunking strategies (configurable by `ChunkingConfig`).
- `rag/embedding.ts` — the `EmbeddingProvider` abstraction. Providers are BYOK and swappable.
- `rag/ingestion.ts` — end-to-end ingest: document → chunks → embeddings → vector store.
- `rag/vector-store.ts` — the `VectorStore` interface, tenant-scoped via `TenantId`. Bring your own backend (pgvector, Pinecone, an in-memory impl for tests).
- `rag/knowledge-base.ts` — a named collection of documents with metadata and config.
- `rag/retriever.ts` — the retrieval query path: vector, keyword (BM25) or hybrid, with configurable top-k and score threshold. Hybrid normalises both rankings before blending them by `hybridAlpha`. **There is no rerank stage.** This line used to promise one; there was no rerank stage behind it and no setting to turn it on, so a reader could configure for it and receive nothing.
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

Advisors are **provider-agnostic** and there can be many: put a security advisor on one provider, an architecture advisor on another, a legal advisor on a third, and let the agent decide who to consult. A single advisor pinned to one vendor cannot express "ask the model that is actually good at this".

### 14. Human-in-the-Loop (`types/hitl/`, `manager/plan/lifecycle.ts`, `types/decision/`)

HITL is structured, not just a "pause and wait for input" hook. The kernel defines typed decision contracts: the LLM produces a plan, the plan can be approved / edited / rejected, approval can be per-tool with explicit destructiveness acknowledgment, rejection can carry feedback that re-enters the loop as a new iteration. The plan lifecycle has its own manager so that pending plans persist across checkpoint resumes. The verification gate's `ask` decision routes into this same HITL layer.

The kernel does not render a UI for this — it emits events and exposes a typed API so the UI layer you choose can render them however you like.

### 15. Providers (`provider/`)

An LLM provider implements a narrow interface: given a typed request, return a typed response (streaming or not) and propagate normalized usage, cost, and cache telemetry. Concrete providers live in dedicated sibling packages — `@namzu/anthropic`, `@namzu/bedrock`, `@namzu/http`, `@namzu/lmstudio`, `@namzu/ollama`, `@namzu/openai`, `@namzu/openrouter` — each calling `ProviderRegistry.register('<vendor>', Class, capabilities)` via a `register<Vendor>()` helper. The kernel itself ships only the `LLMProvider` interface, the `ProviderRegistry`, and a pre-registered `MockLLMProvider` for tests and offline work. `provider/telemetry/` normalizes provider-specific response fields (`cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_discount`, Bedrock equivalents) into a single kernel-wide telemetry shape.

`ProviderRegistry` is the single entry point. `ProviderRegistry.create({ type, ... })` returns `{ provider, capabilities }`; TypeScript module augmentation from each provider package gives type-narrowed config. Providers are stateless enough to be shared across runs.

The runtime composes each provider as `fallback(retry(idle(provider)))`. The
idle layer bounds time between chunks rather than total request duration,
aborts the driver's transport without aborting the caller's controller, and
preserves a network-classified cause even when a provider library reports the
transport close as a generic `AbortError`. See [Provider stream idle
bounds](runtime/provider-stream-idle-bound.md) for the default, override,
opt-out, validation, and recovery rules.

### 16. Connectors (`connector/`)

A connector is how an agent reaches external systems. `connector/BaseConnector.ts` is the abstract base; `connector/mcp/` implements MCP connectors in both `stdio` and `http` transports with a `client.ts` and an `adapter.ts` that turns MCP tools into Namzu `ToolDefinition`s; `connector/builtins/` ships the built-in connectors (HTTP, shell, etc.). WHERE a call runs is not a connector concern and does not live here: all five execution backends are in `execution/`, and a connector is one caller of one. Plugin contributions can register connectors at runtime.

### 17. Prompt Cache Integration

The kernel takes prompt caching seriously because token cost is a production constraint for agents. `runtime/query/prompt-cache.ts` maintains a `PromptCache` identified by agent and project. It hashes the prompt inputs and rebuilds only when that hash changes. Static and dynamic segments are tracked separately so changing turn-local context does not invalidate a reusable static prefix; provider-reported cache usage flows back into the run's usage metrics.

This is why `PromptBuilder` splits a request into static and dynamic segments: the static segment is the cache target, and the kernel does the bookkeeping to keep it stable across iterations so the cache actually hits.

### 18. Vault (`vault/`)

The vault holds BYOK credentials and arbitrary secrets. `InMemoryCredentialVault` is the default backend; the `CredentialVault` interface lets you plug in your own. Credentials are tenant-scoped — tenant A cannot see tenant B's keys. Tools, providers, and connectors resolve credentials through the vault rather than reading environment variables directly, so you can rotate without redeploying and you can audit who accessed what.

### 19. Telemetry (`telemetry/`)

OpenTelemetry-native. The SDK's telemetry constants define the correlation keys used by run, model and tool spans and logs. Run context carries tenant, project, topic, session and run identities; the current compatibility key `NAMZU.THREAD_ID` still carries the `topicId` value until that exported telemetry name completes its deprecation window. Provider-reported input, output and cache usage flows into the run's usage and cost records.

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

### 24. Topic / Run Separation

A **topic** is the durable subject under which sessions work. A **session** is the multi-turn work unit owned by one actor at a time, and a **run** is one execution pass with its own input, iterations, tool calls, usage, cost, and result. One topic can own many sessions and each session can produce many runs. Keeping those identities explicit lets a topic retain mutable conversation state and a bounded objective without mixing either into a run's auditable event history.

---


## Design Principles

Five choices shape every decision in the kernel.

**No workarounds. Fix at the root.** When something is wrong, we fix the pattern, not the symptom. A subtle bug in the lifecycle manager means the lifecycle manager changes — we do not paper over it in the agent pattern that calls it.

**Type safety is the foundation.** Every resource ID is branded (`RunId`, `TopicId`, `SessionId`, `TaskId`, `TenantId`, `ToolId`, `MemoryId`, `ChunkId`...). Every discriminated union has exhaustiveness checks. Every public API has Zod-validated inputs at the boundary. The TypeScript compiler is not a formality; it is the first line of defense.

**Deny by default. Fail fast.** Sandboxes deny file I/O by default. Verification gates deny tool calls by default unless a rule allows them. Limit checkers fail the run the moment a budget is breached. Configuration errors throw at boot, not at the 90-minute mark of a long-running job.

**Dependency direction is sacred.** `@namzu/sdk` is the dependency root. The CLI, capability packages, telemetry, evals and provider drivers may import it; the SDK does not import them, and sibling packages do not import one another. Circular dependencies are a compile error, not a code-review suggestion. This is what keeps the kernel's interface surface small even as its guts grow.

**Convention over surprise.** Every new feature follows a shared pattern language — Registries, Managers, Stores, Runs, Bridges, Providers. You read one subsystem, you can navigate the next one.

---

## The Agent Event Protocol (AEP)

The kernel's contract with the outside world is a typed, versioned event stream. Any UI, any shell, any observability tool subscribes to AEP and renders what it wants.

AEP flows over three transports:

- **Bus** (`bus/`) — in-process, for tightly-coupled consumers.
- **SSE** (`bridge/sse/mapper.ts`) — cross-process over HTTP, for web UIs and remote observers.
- **A2A** (`bridge/a2a/`) — cross-agent, for multi-agent meshes.

Every transport emits the same `RunEvent` union. Every event carries `type` and `runId`; variants add only the identifiers and payload they need, such as `toolUseId`, `taskId`, `planId`, `parentRunId`, or `depth`. Topic, session, project and tenant correlation belongs to the run context and durable run metadata rather than being repeated on every event variant.

AEP v1 is being finalized. Until the spec is stamped, treat the event shapes as semver-minor.

---

## What You Can Build

Namzu is not a toy. It is meant for real workloads.

**Personal and homelab.** A home-automation agent monitoring logs, restarting services, running health checks. A personal research agent feeding PDFs and notes through the RAG pipeline into a knowledge base, answering with citations from your own data. A code-review agent watching your repos, reviewing PRs with a `PipelineAgent` (extract diff → analyze → write review), and posting feedback automatically. A media organizer scanning your library, categorizing files, renaming based on metadata, deduplicating.

**Business and team.** A customer-support triage system where a `RouterAgent` classifies incoming tickets and delegates to specialized children (billing, technical, general), each with its own persona, tools, and knowledge base. A document-processing pipeline ingesting contracts, invoices, and reports through RAG, extracting key data, flagging anomalies, generating summaries, with HITL approval for anything destructive. An internal-ops bot that plugs into Slack, Jira, and your database over MCP. A compliance checker where a `SupervisorAgent` coordinates sub-agents each checking a different regulation, then aggregates results and routes flagged items through plan review.

**Platform and SaaS.** This is the shape Namzu was designed for from day one. Agent-as-a-Service — each customer gets isolated agents with their own BYOK keys, connector configs, and knowledge bases; tenant isolation is built in, not bolted on. An agent marketplace — agents are portable definitions (`info + tools + persona + skills`), publishable, deployable by any customer with their own keys, specializable through persona inheritance. Cross-organization workflows where agents from different companies discover each other via A2A agent cards and collaborate without a central authority.

---

## Quality Bar

The architectural bar this kernel holds itself to is written down in
its own terms: dependency direction is one-way and enforced, every
public type has a producer and a consumer, a control that cannot be
enforced is refused rather than downgraded, and a gate says which way
it fails. Those are checkable in the source, which is the only kind of
claim worth making.

Where the work is: test coverage is not yet where the architecture
deserves. Closing that gap is the highest-leverage contribution today.

---

## Where this is going

The kernel is deep and the surface is deliberately small. What moves next is
the surface: fewer names, better names, and a deprecation window on every one
that changes.

This section used to carry a version-numbered roadmap. It was written at 0.x
and the package is well past it — several of its items shipped under different
names, and a plan a reader cannot trust is worse than no plan. The changelog is
the record of what
actually landed; the repository's issues are where what is next gets argued.

Explicitly out of scope, and staying that way: framework chat hooks, hosting
adapters, a studio playground, a dashboard. They belong on top of a kernel with
a small stable interface, which is the only reason that interface can stay
small.

---
