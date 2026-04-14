# Namzu

Open-source AI agent SDK with a built-in runtime. Nothing between you and your agents.

[![npm](https://img.shields.io/npm/v/@namzu/sdk?color=blue)](https://www.npmjs.com/package/@namzu/sdk)
[![CI](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-FSL--1.1--MIT-green)](./LICENSE.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)

> **Our goal is to build an open, community-driven agent framework that reduces systemic dependencies on proprietary platforms — so that everyone can build, own, and run AI agents freely.** Namzu is designed to work with any LLM provider through a bring-your-own-key model, and every version becomes fully open source (MIT) after two years. If this vision resonates with you, we'd love your help — whether it's a bug report, a feature idea, a pull request, or just spreading the word. Every contribution matters.

## Why Namzu?

There are great agent frameworks out there — LangChain, CrewAI, AutoGen, Vercel AI SDK, OpenAI Agents SDK. Each solves a real problem. Namzu exists because we think some things are still missing.

**Sandboxed execution.** Agents execute tools inside process-level sandboxes. macOS uses Seatbelt (SBPL) profiles for deny-default file-I/O and process isolation. Linux uses lightweight mount + PID namespace isolation for process scoping, with resource limits (memory, timeout, max processes) enforced by the runtime. No Docker, no containers.

**True provider independence.** Most frameworks say they're provider-agnostic but are optimized for one vendor. Namzu treats every provider as a first-class citizen through BYOK (Bring Your Own Key). Switch from OpenRouter to Bedrock by changing one line. No performance penalties, no second-class APIs.

**Thread/Run separation.** Other frameworks mix conversation history with execution traces. Namzu cleanly separates threads (user↔assistant conversation) from runs (tool calls, iterations, internal state). Multi-turn conversations carry only the context that matters.

**A2A + MCP in one SDK.** Google's Agent-to-Agent protocol and Anthropic's Model Context Protocol are usually separate integrations. Namzu bridges both natively — your agents can expose capabilities via A2A agent cards and consume external tools via MCP, out of the box.

**Multi-tenant from day one.** Most frameworks assume single-user, single-process. Namzu ships with tenant isolation, scoped connector registries, and environment-aware configuration. Building a platform where multiple teams run agents? That's the default, not an afterthought.

**Human-in-the-loop that actually works.** Not just "pause and wait for input." Namzu has structured plan review, per-tool approval with destructiveness flags, checkpoint/resume across sessions, and a decision framework that gives humans real control without breaking the agent loop.

**Persona system with inheritance.** Define agent identity, expertise, reflexes, and output format as structured data. Specialize agents through inheritance — a base researcher persona becomes an ML researcher by merging one field. No prompt string concatenation.

**Progressive tool disclosure.** Agents don't see all tools at once. Tools start as deferred (searchable but not active), get activated on demand, and can be suspended. This keeps the LLM's context focused and reduces hallucinated tool calls.

**Advisory System.** A three-layer advisory architecture where agents can consult specialized advisors mid-execution. Unlike Anthropic's Advisor Tool (Claude-only, single advisor), Namzu's system is provider-agnostic (any model advises any model via BYOK), supports multi-advisor with domain routing, configurable triggers, and agent-autonomous consultation. Define a security advisor on Bedrock, an architecture advisor on OpenRouter, and let the agent decide when to consult whom.

**Structured compaction.** When context reaches capacity, Namzu doesn't just truncate — it incrementally extracts structured data (task, plan, files, decisions, failures) into a typed WorkingState, serializes it as compact markdown, and replaces old messages. The agent continues with full context awareness at a fraction of the token cost.

**Tool tiering.** Configurable tier system that teaches the LLM to prefer cheaper tools first. Unlike hardcoded approaches, Namzu's tiers are fully user-defined — bring your own tier labels, priorities, and guidance templates.

**Task routing.** Route sub-tasks to different models based on task type. Compaction and summarization go to cheap models, coding stays on expensive ones. Provider-agnostic, configurable per task type, with automatic fallback chains.

| | Namzu | LangChain/LangGraph | CrewAI | OpenAI Agents SDK | Vercel AI SDK |
|---|---|---|---|---|---|
| Language | TypeScript | Python/JS | Python | Python/JS | TypeScript |
| Provider lock-in | None (BYOK) | Low | Low | Optimized for OpenAI | Low |
| **Process sandbox** | **Native (Seatbelt + NS)** | No | No | No | No |
| Agent patterns | 4 (reactive, pipeline, router, supervisor) | Graph-based | Role-based crews | Handoffs | Single-agent |
| A2A protocol | Native | No | No | No | No |
| MCP support | Native (client + server) | Plugin | No | Client only | No |
| Multi-tenant | Built-in | No | No | No | No |
| Thread/Run separation | Yes | No | No | Sessions | No |
| Plan review (HITL) | Structured | Graph interrupts | No | Basic | Tool approval |
| Persona inheritance | Yes | No | Role strings | Instructions | System prompt |
| Progressive tool loading | Yes | No | No | No | No |
| Advisory system | Multi-advisor, provider-agnostic | No | No | No | No |
| Context compaction | Structured WorkingState | No | No | No | No |
| Tool tiering | Configurable, user-defined | No | No | No | No |
| Task routing | Per-task model selection | No | No | No | No |
| RAG built-in | Full pipeline | Via integrations | Via integrations | Via tools | No |
| Telemetry | OpenTelemetry | LangSmith | CrewAI+ | Built-in tracing | No |

### Architecture Quality Scores

> **Note:** These scores are AI-generated based on public documentation, community feedback, and (for Namzu) direct codebase analysis. They are not official benchmarks — treat them as an informed architectural comparison, not a definitive ranking. We tried to be fair; if you disagree with a score, open an issue and let's discuss.

| Criterion | Namzu | LangChain/LangGraph | CrewAI | OpenAI Agents SDK | Vercel AI SDK |
|---|---|---|---|---|---|
| Type Safety | 9 | 5 | 7 | 7 | 9 |
| Modularity | 9 | 5 | 7 | 8 | 9 |
| Interface Segregation | 8 | 4 | 6 | 8 | 8 |
| Extensibility | 9 | 7 | 6 | 6 | 7 |
| Convention Consistency | 8 | 5 | 7 | 8 | 8 |
| Dependency Direction | 9 | 4 | 6 | 8 | 8 |
| **Overall** | **8.7** | **5.0** | **6.5** | **7.5** | **8.2** |

**What the scores tell us:**

- **Namzu** scores highest on type safety, extensibility, and dependency direction — its branded ID system, abstract base patterns, and clean acyclic module graph are genuine strengths.

- **LangChain/LangGraph** suffers from well-documented abstraction bloat and dependency issues. The community consistently reports difficulty debugging, deep coupling between modules, and frequent breaking changes.

- **CrewAI** offers clean role-based design with Pydantic validation, but is Python-only with limited extensibility for custom agent patterns beyond crews. Security-conscious with task-level tool scoping.

- **OpenAI Agents SDK** is deliberately minimal — four primitives, clean design, good type safety in its TypeScript variant. Limited by a narrow scope: no RAG, no multi-tenant, no A2A. Optimized for OpenAI models.

- **Vercel AI SDK** has the strongest frontend integration and end-to-end type safety from server to client. Clean modular architecture. Focused on web/chat UIs rather than backend agent orchestration.

**Where Namzu needs to improve:** Test coverage is the next priority — the focus so far has been getting the architecture and core abstractions right. Now that the foundation is solid, comprehensive testing is next. Contributions are very welcome here.

## What Can You Build?

Namzu is not a toy framework for chatbot demos. It's designed for real workloads — whether you're automating your homelab, streamlining business operations, or building a full agent platform.

### Personal & Homelab

**Your own AI assistant that actually does things.** Not just answers questions — executes. Connect it to your file system, your scripts, your local services via MCP, and let it manage your infrastructure through conversation.

- **Home automation agent** — monitors logs, restarts services, runs health checks, alerts you when something breaks. Give it bash + read-file tools and a reactive loop.
- **Personal research agent** — feeds documents into the RAG pipeline, builds a knowledge base from your notes/PDFs/bookmarks, and answers questions with citations from your own data.
- **Code review agent** — watches your repos, reviews PRs with a pipeline agent (extract diff → analyze → write review), posts feedback automatically.
- **Media organizer** — scans your library, categorizes files, renames based on metadata, deduplicates. A pipeline agent with file tools handles this end to end.

### Business & Team

**Agents that plug into your existing workflows.** Namzu's connector system and multi-tenant isolation mean you can deploy agents for different teams without them stepping on each other.

- **Customer support triage** — a router agent classifies incoming tickets and delegates to specialized agents (billing, technical, general). Each agent has its own persona, tools, and knowledge base.
- **Document processing pipeline** — ingest contracts, invoices, or reports through RAG. Agents extract key data, flag anomalies, and generate summaries. Human-in-the-loop ensures nothing gets approved without review.
- **Internal ops bot** — connects to your existing tools (Slack, Jira, databases) via HTTP connectors or MCP servers. Team members ask questions in natural language, the agent queries the right systems and responds.
- **Compliance checker** — a supervisor agent coordinates specialized sub-agents that each check a different regulation. Results are aggregated, flagged items go through plan review before any action is taken.

### Platform & SaaS

**Build a multi-tenant agent platform for your users.** This is what Namzu was designed for from the start.

- **Agent-as-a-Service** — each customer gets isolated agents with their own API keys (BYOK), connector configs, and knowledge bases. Tenant isolation is built in, not bolted on.
- **Agent marketplace** — define agents as portable definitions (info + tools + persona), publish them, let others deploy with their own keys and customize via persona inheritance.
- **Cross-organization workflows** — agents from different companies discover each other via A2A agent cards and collaborate on shared tasks without a central authority.

## Install

```bash
npm install @namzu/sdk
```

## Quick Start

```typescript
import { defineTool, ProviderFactory, ReactiveAgent, ToolRegistry } from '@namzu/sdk'
import { z } from 'zod'

// Define a tool
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
    const results = await fetch(`https://api.search.com?q=${query}`)
    return { success: true, output: await results.text() }
  },
})

// Create a provider (model is chosen per-run, not on the provider)
const provider = ProviderFactory.createProvider({
  type: 'openrouter',
  apiKey: process.env.OPENROUTER_KEY!,
})

// Register tools and build the agent
const tools = new ToolRegistry()
tools.register(searchWeb)

const agent = new ReactiveAgent({
  id: 'researcher',
  name: 'Research Assistant',
  version: '1.0.0',
  category: 'research',
  description: 'Finds and synthesizes information from the web',
})

const result = await agent.run(
  { messages: [{ role: 'user', content: 'Summarize the latest LLM benchmarks' }], workingDirectory: process.cwd() },
  { model: 'anthropic/claude-sonnet-4-20250514', tokenBudget: 8192, timeoutMs: 600_000, provider, tools },
)
```

## Agent Types

Namzu provides four agent orchestration patterns, each designed for different execution models.

### Reactive Agent

The core agentic loop. Sends messages to an LLM, executes tool calls, and iterates until the task is complete or a stop condition is hit (token budget, cost limit, timeout, max iterations).

```typescript
import { ReactiveAgent } from '@namzu/sdk'

const agent = new ReactiveAgent({
  id: 'solver',
  name: 'Problem Solver',
  version: '1.0.0',
  category: 'analysis',
  description: 'Analyzes data with LLM + tools',
})

const result = await agent.run(
  { messages: [{ role: 'user', content: 'Analyze this dataset and find trends' }], workingDirectory: process.cwd() },
  {
    model: 'anthropic/claude-sonnet-4-20250514',
    tokenBudget: 8192,
    timeoutMs: 600_000,
    provider,
    tools,                          // ToolRegistry
    systemPrompt: 'You are a data analyst.',
  },
)
```

### Pipeline Agent

Deterministic, sequential step execution. Each step receives the output of the previous one. Supports rollback on failure.

```typescript
import { PipelineAgent } from '@namzu/sdk'

const etl = new PipelineAgent({
  id: 'etl',
  name: 'ETL Pipeline',
  version: '1.0.0',
  category: 'pipeline',
  description: 'Extract → transform → load',
})

const result = await etl.run(
  { messages: [], workingDirectory: process.cwd() },
  {
    model: 'anthropic/claude-sonnet-4-20250514',
    tokenBudget: 8192,
    timeoutMs: 600_000,
    steps: [
      { name: 'extract',   execute: async (inp, ctx) => await readSource('./data') },
      { name: 'transform', execute: async (data, ctx) => normalize(data) },
      { name: 'load',      execute: async (data, ctx) => await writeToDb(data) },
    ],
  },
)
```

### Router Agent

Intelligent delegation. An LLM analyzes the input and routes it to the best-suited agent from a set of candidates.

```typescript
import { RouterAgent } from '@namzu/sdk'

const router = new RouterAgent({
  id: 'dispatcher',
  name: 'Task Router',
  version: '1.0.0',
  category: 'routing',
  description: 'Routes an input to the best-fit agent',
})

const result = await router.run(
  { messages: [{ role: 'user', content: 'Solve 2x + 3 = 11' }], workingDirectory: process.cwd() },
  {
    model: 'anthropic/claude-sonnet-4-20250514',
    tokenBudget: 4096,
    timeoutMs: 600_000,
    provider,
    routes: [
      { agentId: 'math-solver', agent: mathAgent, description: 'Solves equations' },
      { agentId: 'writer',      agent: writerAgent, description: 'Writes content' },
    ],
    fallbackAgentId: 'writer',
  },
)
```

### Supervisor Agent

Multi-agent coordinator. Manages child agents, delegates tasks, aggregates results, and tracks the full run hierarchy.

```typescript
import { SupervisorAgent, AgentManager } from '@namzu/sdk'

const supervisor = new SupervisorAgent({
  id: 'lead',
  name: 'Project Lead',
  version: '1.0.0',
  category: 'coordination',
  description: 'Delegates sub-tasks to specialized agents',
})

const result = await supervisor.run(
  { messages: [{ role: 'user', content: 'Research, write, and review a Q3 report' }], workingDirectory: process.cwd() },
  {
    model: 'anthropic/claude-sonnet-4-20250514',
    tokenBudget: 32_768,
    timeoutMs: 1_800_000,
    provider,
    agentManager,                                        // resolves agent ids → implementations
    agentIds: ['researcher', 'writer', 'reviewer'],
    systemPrompt: 'You coordinate specialists. Decompose tasks, delegate, and synthesize results.',
  },
)
// Child runs tracked via parent_run_id and depth
```

## Tool System

Define tools with Zod schemas, permission declarations, and destructiveness flags. The SDK includes built-in tools for file I/O, shell commands, and glob search.

```typescript
import { defineTool, ToolRegistry, getBuiltinTools } from '@namzu/sdk'
import { z } from 'zod'

const fetchApi = defineTool({
  name: 'fetch_api',
  description: 'Call an external API endpoint',
  inputSchema: z.object({ url: z.string().url(), method: z.enum(['GET', 'POST']) }),
  category: 'network',
  permissions: ['network_access'],
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  execute: async ({ url, method }) => {
    const resp = await fetch(url, { method })
    return { success: true, output: await resp.text() }
  },
})

// Tool registry with progressive activation
const registry = new ToolRegistry()
registry.register(getBuiltinTools(), 'deferred')
registry.register(fetchApi, 'active')

// Agents can search deferred tools and activate on demand
registry.activate(['read_file', 'bash'])
const llmTools = registry.toLLMTools() // Only active + suspended tools
```

Built-in tools: `ReadFileTool`, `WriteFileTool`, `EditTool`, `BashTool`, `GlobTool`, `GrepTool`, `LsTool`, `SearchToolsTool`

### Plugin Contributions

Plugins extend the runtime with tools, hooks, and MCP servers via a manifest. `PluginLifecycleManager.enable()` loads contributions on demand and rolls back cleanly on failure.

```typescript
import { PluginLifecycleManager } from '@namzu/sdk'

const manager = new PluginLifecycleManager({ pluginRegistry, toolRegistry, log })
const plugin = await manager.install('/path/to/plugin', 'project')
await manager.enable(plugin.id)
// → manifest.tools registered as `${plugin}:${tool}` (deferred)
// → manifest.hooks attached for run_start/end, iteration_start/end,
//   pre/post_llm_call, pre/post_tool_use
// → manifest.mcpServers connected via stdio; their tools registered as
//   `${plugin}:mcp__${server}__${tool}` (deferred)
```

Hook handlers can return `continue`, `modify` (rewrite tool input), `skip` (synthesize a tool result), or `error` (fail the run). Modify actions compose — chained hooks each see the previous hook's modified input. The runtime emits `plugin_hook_executing` / `plugin_hook_completed` events around every handler.

### Sandbox-Aware Execution

File and shell built-ins (`ReadFileTool`, `WriteFileTool`, `EditTool`, `BashTool`) route through `sandbox.exec()` / `sandbox.readFile()` / `sandbox.writeFile()` when a sandbox is present in the execution context, and fall back to native operations when not. Use `query()` (streaming generator) with a `ToolRegistry` and a `sandboxProvider`:

```typescript
import { drainQuery, ToolRegistry, getBuiltinTools } from '@namzu/sdk'

const tools = new ToolRegistry()
tools.register(getBuiltinTools(), 'active')

// With sandbox: file + shell tool calls are isolated to the agent workspace
const result = await drainQuery({
  agentId: 'solver', agentName: 'Solver', threadId,
  provider, tools, runConfig, messages, resumeHandler,
  sandboxProvider,
})
```

## Sandbox

Process-level isolation for agent tool execution. No Docker, no containers — native OS mechanisms.

```typescript
import { drainQuery, SandboxProviderFactory, ToolRegistry, getBuiltinTools, getRootLogger } from '@namzu/sdk'

const sandboxProvider = SandboxProviderFactory.create(
  { enabled: true, provider: 'local', timeoutMs: 60_000, memoryLimitMb: 512, maxProcesses: 16, cleanupOnDestroy: true },
  getRootLogger(),
)

const tools = new ToolRegistry()
tools.register(getBuiltinTools(), 'active')

const result = await drainQuery({
  agentId: 'coder', agentName: 'Coder', threadId,
  provider, tools, runConfig,
  messages: [{ role: 'user', content: 'Write a Python script and run it' }],
  resumeHandler,
  sandboxProvider,                                      // sandbox-aware tools opt in here
})
```

**How it works:**

| Platform | Mechanism | Profile |
|----------|-----------|---------|
| macOS | `sandbox-exec` with Seatbelt (SBPL) | Deny-default, allow-back for agent workspace |
| Linux | Namespace isolation | Process + filesystem isolation |

The sandbox creates a temporary workspace directory, restricts file I/O to that directory, and destroys everything on cleanup. The seatbelt profile is minimal by design:

- **Deny-default** — nothing is allowed unless explicitly granted
- **Workspace-scoped I/O** — reads and writes only within the agent's `rootDir`
- **Path canonicalization** — resolves macOS symlinks (`/var` → `/private/var`) so seatbelt rules match real paths
- **Process isolation** — `same-sandbox` scope for signals and process info
- **Automatic lifecycle** — sandbox is created before query iteration, destroyed in `finally`

```typescript
// Direct sandbox API (low-level)
const sandbox = await sandboxProvider.create({
  workingDirectory: process.cwd(),
  timeoutMs: 30_000,
  memoryLimitMb: 512,
  maxProcesses: 16,
})

const result = await sandbox.exec('/bin/sh', ['-c', 'echo hello'], { timeoutMs: 5_000 })
console.log(result.stdout)  // "hello\n"
console.log(result.exitCode) // 0

await sandbox.writeFile('script.py', 'print("namzu")')
const content = await sandbox.readFile('script.py')

await sandbox.destroy() // Cleanup workspace
```

## Providers

Pluggable LLM backends with a unified interface for chat, streaming, and model discovery.

The provider is constructed once with credentials; the model is selected per chat/run so you can swap models without rebuilding the client.

```typescript
import { ProviderFactory } from '@namzu/sdk'

// OpenRouter (BYOK)
const openrouter = ProviderFactory.createProvider({
  type: 'openrouter',
  apiKey: process.env.OPENROUTER_KEY!,
})

// AWS Bedrock
const bedrock = ProviderFactory.createProvider({
  type: 'bedrock',
  region: 'us-east-1',
})

// Streaming — model is part of the per-call params
for await (const chunk of openrouter.chatStream({
  model: 'anthropic/claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'hi' }],
})) {
  process.stdout.write(chunk.delta?.content ?? '')
}

// Model discovery
const models = await openrouter.listModels()
```

## RAG

End-to-end retrieval-augmented generation: chunk documents, embed them, store and search vectors, and inject context into agent prompts.

```typescript
import {
  TextChunker,
  OpenRouterEmbeddingProvider,
  InMemoryVectorStore,
  DefaultRetriever,
  DefaultKnowledgeBase,
  createRAGTool,
} from '@namzu/sdk'

// Chunking (fixed-size, sentence, paragraph, or recursive)
const chunker = new TextChunker()
const chunks = chunker.chunk(document, {
  strategy: 'recursive',
  chunkSize: 512,
  chunkOverlap: 64,
})

// Embedding
const embedder = new OpenRouterEmbeddingProvider({
  model: 'openai/text-embedding-3-small',
  apiKey: process.env.OPENROUTER_KEY!,
})

// Vector store and retriever
const vectorStore = new InMemoryVectorStore()
const retriever = new DefaultRetriever(vectorStore, embedder)

// Knowledge base — pass (config, vectorStore, embeddingProvider)
const kb = new DefaultKnowledgeBase(
  { id: 'docs', name: 'API Guides', tenantId: 'default' },
  vectorStore,
  embedder,
)
await kb.ingest(apiDoc, { title: 'API Guide', source: 'doc-1' })
const results = await kb.query({ text: 'How do I authenticate?', config: { topK: 5 } })

// Attach to agent as a tool
const ragTool = createRAGTool({
  knowledgeBases: new Map([['docs', kb]]),
  defaultKnowledgeBaseId: 'docs',
})
```

## Connectors

Unified framework for integrating external services — HTTP APIs, webhooks, and MCP servers — with execution contexts and multi-tenant isolation.

```typescript
import {
  HttpConnector,
  ConnectorManager,
  ConnectorRegistry,
  MCPClient,
  MCPConnectorBridge,
  TenantConnectorManager,
} from '@namzu/sdk'

// HTTP connector — configure via connect()
const slack = new HttpConnector()
await slack.connect(
  { id: 'slack', baseUrl: 'https://slack.com/api' },
  { type: 'bearer', token: process.env.SLACK_TOKEN! },
)

// MCP client (stdio or HTTP-SSE transport)
const mcpClient = new MCPClient({
  serverName: 'my-tools',
  transport: { type: 'stdio', command: 'node', args: ['server.js'] },
})
await mcpClient.connect()
const tools = await mcpClient.listTools()
const result = await mcpClient.callTool('my_tool', { input: 'value' })

// Bridge MCP as a connector so connector-based code paths can reach it
const connectorManager = new ConnectorManager({ registry: new ConnectorRegistry() })
const mcpBridge = new MCPConnectorBridge({ manager: connectorManager })
const discoveredTools = await mcpBridge.listTools()
await mcpBridge.callTool('my_tool', { input: 'value' })

// Multi-tenant isolation
const tenantManager = new TenantConnectorManager({ registry: new ConnectorRegistry() })
tenantManager.registerTenant({ tenantId: 'org-123', name: 'Org 123' })
```

MCP servers can also be declared in a plugin manifest (`mcpServers: [{ name, command, args, env }]`). The plugin lifecycle starts each server on enable, discovers its tools, and registers them under the plugin namespace. Disable disconnects the clients before unregistering the tools.

## Human-in-the-Loop

Pause agent execution for human review of plans and tool calls. Checkpoint and resume runs across sessions.

Plan approval and tool review are separate handlers wired at different points:

```typescript
import { PlanManager, drainQuery, autoApproveHandler } from '@namzu/sdk'
import type { ResumeHandler } from '@namzu/sdk'

// 1. Plan approval — runs when the agent produces a plan
const planManager = new PlanManager(runId, async (request) => {
  const decision = await showPlanUI(request)
  return {
    approved: decision.approved,
    feedback: decision.feedback,
    modifiedSteps: decision.editedSteps,
  }
})

// 2. Tool review — runs for every pending tool call (required by query/drainQuery)
const resumeHandler: ResumeHandler = async (request) => {
  if (request.type === 'tool_review') {
    const hasDestructive = request.toolCalls.some((t) => t.isDestructive)
    return hasDestructive
      ? { action: 'reject_tools', feedback: 'Destructive tool blocked' }
      : { action: 'approve_tools' }
  }
  if (request.type === 'plan_approval') {
    return { action: 'approve_plan' }
  }
  return { action: 'continue' }
}

await drainQuery({ /* ...runConfig, provider, tools, messages, */ resumeHandler })
```

Checkpoint/resume enables long-running agents to pause and restart without losing state (`CheckpointManager`, `checkpointId` in `QueryParams`).

## A2A Protocol

Agent-to-Agent protocol support for cross-platform agent interoperability. Publish agent cards, accept A2A messages, and bridge between Namzu runs and A2A tasks.

```typescript
import { buildAgentCard, runToA2ATask, a2aMessageToCreateRun } from '@namzu/sdk'

// Publish agent capabilities as an A2A Agent Card
const card = buildAgentCard(agentInfo, {
  baseUrl: 'https://api.example.com',
  transport: 'rest',
  providerOrganization: 'Cogitave',
})
// Serve at /.well-known/agent-card.json

// Convert an inbound A2A message-send into run creation params
const runParams = a2aMessageToCreateRun(agentId, {
  message: a2aMessage,
  contextId: a2aMessage.contextId,
  metadata: { model: 'anthropic/claude-sonnet-4-20250514', tokenBudget: 8192 },
})

// Convert a persisted Run (wire type) + thread messages into an A2A task response
const a2aTask = runToA2ATask(run, threadMessages)
```

## Streaming (SSE)

Map internal agent execution events to Server-Sent Events for real-time client updates.

Agents emit `RunEvent`s through the listener passed to `run()` / `drainQuery()`. `mapRunToStreamEvent` translates those into SSE-ready `{ event, data }` tuples (returns `null` for events without a wire mapping, which you should skip):

```typescript
import { mapRunToStreamEvent, drainQuery } from '@namzu/sdk'

// Event families: run.*, iteration.*, tool.*, token.*, message.*, review.*,
// checkpoint.*, activity.*, plan.*, agent.*, task.*, plugin.*, sandbox.*
const listener = (event) => {
  const mapped = mapRunToStreamEvent(event, runId)
  if (!mapped) return
  response.write(`event: ${mapped.wire}\ndata: ${JSON.stringify(mapped.data)}\n\n`)
}

await drainQuery({ /* ...runConfig, provider, tools, messages */ }, listener)
```

## Persona System

Layer-based system prompt assembly with inheritance. Define identity, expertise, reflexes, and output format as structured data.

```typescript
import { assembleSystemPrompt, mergePersonas, withSessionContext } from '@namzu/sdk'

const basePersona = {
  identity: { role: 'Research Agent', description: 'Gathers and synthesizes information' },
  expertise: { domains: ['academic research', 'data analysis'] },
  reflexes: { constraints: ['Always cite sources', 'Be concise'] },
  output: { format: 'markdown' },
}

// Specialize via inheritance
const mlResearcher = mergePersonas(basePersona, {
  expertise: { domains: ['machine learning', 'NLP'] },
})

// Assemble final system prompt with skills injected
const systemPrompt = assembleSystemPrompt(mlResearcher, loadedSkills)
```

## Skills System

Reusable agent behaviors with progressive disclosure (metadata-only → full body) and inheritance chains.

```typescript
import { SkillRegistry, resolveSkillChain } from '@namzu/sdk'

const registry = new SkillRegistry()
await registry.registerAll('/path/to/skills', 'metadata')

// Load full skill content on demand — returns SkillLoadResult | undefined
const loaded = await registry.load('web-search', 'full')
const skill = loaded?.skill

// Resolve inheritance: shared skills + agent-specific overrides
const chain = await resolveSkillChain(
  '/skills/shared',
  '/skills/agent-specific',
  'metadata',
)
```

## Threads & Conversations

Namzu separates **threads** (clean user↔assistant conversation history) from **runs** (full execution traces with tool calls, iterations, and internal state). This means multi-turn conversations carry only the relevant context — no tool noise leaking between runs.

```typescript
import { InMemoryConversationStore } from '@namzu/sdk'

const store = new InMemoryConversationStore({ maxMessages: 50 })

// Start a thread
store.createThread('thd_abc123')
store.addUserMessage('thd_abc123', 'What is the capital of France?')

// After a run completes, persist only the final assistant response
store.persistRunResult('thd_abc123', runId, runMessages)

// Next run loads clean conversation history (no tool calls, no system messages)
const history = store.loadMessages('thd_abc123')
// → [{ role: 'user', content: '...' }, { role: 'assistant', content: '...' }]
```

The `ConversationStore` interface is pluggable — swap in SQLite, Postgres, or any backend. `InMemoryConversationStore` is bundled for non-persistent use; applications wire it into the runtime themselves.

## Persistence

In-memory and disk-backed stores for runs, tasks, conversations, and activities.

```typescript
import { RunPersistence, DiskTaskStore, getRootLogger } from '@namzu/sdk'

// Run persistence with token/cost tracking
const persistence = new RunPersistence({
  runId,
  agentId: 'researcher',
  agentName: 'Research Assistant',
  providerId: 'openrouter',
  outputDir: './runs',
  runConfig: {
    model: 'anthropic/claude-sonnet-4-20250514',
    tokenBudget: 8192,
    timeoutMs: 600_000,
    temperature: 0.7,
  },
  log: getRootLogger(),
})
await persistence.init()
persistence.accumulateUsage({
  promptTokens: 100,
  completionTokens: 50,
  totalTokens: 150,
})
await persistence.persist()

// Task store with atomic writes (tenant-aware)
const taskStore = new DiskTaskStore({
  baseDir: './tasks',
  defaultRunId: runId,
  tenantId: 'org-1',
})
```

## Telemetry

OpenTelemetry integration for distributed tracing and metrics across agents, tools, and providers.

```typescript
import { initTelemetry, getTracer, createPlatformMetrics } from '@namzu/sdk'

const telemetry = initTelemetry({
  serviceName: 'agent-platform',
  exporterType: 'otlp',
  otlpEndpoint: 'http://localhost:4318',
  otlpHeaders: { authorization: `Bearer ${process.env.OTLP_TOKEN!}` },
})
await telemetry.start()

const tracer = getTracer()
const metrics = createPlatformMetrics()

const span = tracer.startSpan('agent.run')
metrics.recordTokenUsage('anthropic/claude-sonnet-4-20250514', 100, 50)
metrics.recordToolCall('search_web', true)
span.end()

metrics.recordRunDuration('completed', 12.4)
```

## Architecture

```
@namzu/sdk
├── advisory/        Advisor registry, execution, trigger evaluation
├── agents/          Reactive, Pipeline, Router, Supervisor
├── bridge/          A2A, SSE, connector→tool adapters
├── bus/             Agent bus and coordination primitives
├── compaction/      WorkingState extraction and conversation compaction
├── config/          Runtime configuration with Zod schemas
├── connector/       HTTP, webhook, MCP client/server, tenant isolation
├── constants/       Shared SDK constants
├── contracts/       External wire types and validation schemas (HTTP/A2A/SSE)
├── execution/       Base and local execution contexts
├── gateway/         Local task gateway
├── manager/         Plan, agent, connector, run lifecycle
├── persona/         System prompt assembly and merging
├── plugin/          Manifest discovery, lifecycle, contributions, hooks
├── provider/        OpenRouter, Bedrock, Mock LLM providers
├── rag/             Chunking, embedding, vector store, retrieval
├── registry/        Base, managed, agent, connector, tool, plugin registries
├── router/          Task→model routing
├── run/             Reporters and limit checking
├── runtime/         Query engine, iteration phases, decision parser
├── sandbox/         Process-level isolation (Seatbelt, namespace)
├── skills/          Skill registry, discovery, and chaining
├── store/           In-memory, disk, conversation, activity, task, memory
├── telemetry/       OpenTelemetry tracing and metrics
├── tools/           defineTool, built-ins, task / advisory / memory tools
├── types/           Domain model and internal type definitions
├── utils/           ID generation, cost calc, hashing, logging, shell
├── vault/           Credential management
└── verification/    Verification gate and rules
```

## Vision

AI agents shouldn't be locked behind walled gardens. Today, building production-grade agents means choosing a platform and accepting its constraints — its models, its pricing, its rules. We believe agent infrastructure should be open, composable, and owned by the people who build on it.

Namzu exists to make that real. A single SDK that works with any LLM, any tool ecosystem, any deployment model. No vendor lock-in. No surprise pricing changes. No permission needed.

### Where we're headed

**Now** — Core SDK with multi-agent orchestration, tool system, RAG, MCP, and A2A support. Everything you need to build and run agents locally or on your own infrastructure.

**Next** — Managed runtime for deploying agents at scale, conversational agent builder (build, configure, and deploy agents entirely through chat), and a marketplace for sharing agent definitions and tool connectors.

**Later** — Decentralized agent network where agents discover and collaborate with each other across organizations via A2A, without a central authority.

We're building this in the open because we believe the agent layer of the stack should belong to everyone. If you share this belief, come build with us.

## License

This software is licensed under the [Functional Source License, Version 1.1, MIT Future License (FSL-1.1-MIT)](./LICENSE.md).

**What this means:**

- **Free for internal use, education, and research**
- **Free to use in your own products** (as long as you're not building a competing agent platform)
- **Each version converts to MIT after 2 years** — fully open source, no strings attached

Enterprise licensing is available for organizations that need to build competing products or services. Contact us at enterprise@cogitave.com.

## Contributing

We welcome contributions! Please read our contributing guidelines (coming soon) before submitting a PR.

## Security

Found a vulnerability? Please report it responsibly. See [SECURITY.md](./SECURITY.md) for details.

---

Built by [@bahadirarda](https://github.com/bahadirarda) · [Cogitave](https://github.com/Cogitave)
