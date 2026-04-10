# Namzu

Open-source AI agent framework — multi-model, multi-tenant, MCP + A2A native.

[![npm](https://img.shields.io/npm/v/@namzu/sdk?color=blue)](https://www.npmjs.com/package/@namzu/sdk)
[![CI](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-FSL--1.1--MIT-green)](./LICENSE.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)

> **Our goal is to build an open, community-driven agent framework that reduces systemic dependencies on proprietary platforms — so that everyone can build, own, and run AI agents freely.** Namzu is designed to work with any LLM provider through a bring-your-own-key model, and every version becomes fully open source (MIT) after two years. If this vision resonates with you, we'd love your help — whether it's a bug report, a feature idea, a pull request, or just spreading the word. Every contribution matters.

## Why Namzu?

There are great agent frameworks out there — LangChain, CrewAI, AutoGen, Vercel AI SDK, OpenAI Agents SDK. Each solves a real problem. Namzu exists because we think some things are still missing.

**True provider independence.** Most frameworks say they're provider-agnostic but are optimized for one vendor. Namzu treats every provider as a first-class citizen through BYOK (Bring Your Own Key). Switch from OpenRouter to Bedrock by changing one line. No performance penalties, no second-class APIs.

**Thread/Run separation.** Other frameworks mix conversation history with execution traces. Namzu cleanly separates threads (user↔assistant conversation) from runs (tool calls, iterations, internal state). Multi-turn conversations carry only the context that matters.

**A2A + MCP in one SDK.** Google's Agent-to-Agent protocol and Anthropic's Model Context Protocol are usually separate integrations. Namzu bridges both natively — your agents can expose capabilities via A2A agent cards and consume external tools via MCP, out of the box.

**Multi-tenant from day one.** Most frameworks assume single-user, single-process. Namzu ships with tenant isolation, scoped connector registries, and environment-aware configuration. Building a platform where multiple teams run agents? That's the default, not an afterthought.

**Human-in-the-loop that actually works.** Not just "pause and wait for input." Namzu has structured plan review, per-tool approval with destructiveness flags, checkpoint/resume across sessions, and a decision framework that gives humans real control without breaking the agent loop.

**Persona system with inheritance.** Define agent identity, expertise, reflexes, and output format as structured data. Specialize agents through inheritance — a base researcher persona becomes an ML researcher by merging one field. No prompt string concatenation.

**Progressive tool disclosure.** Agents don't see all tools at once. Tools start as deferred (searchable but not active), get activated on demand, and can be suspended. This keeps the LLM's context focused and reduces hallucinated tool calls.

| | Namzu | LangChain/LangGraph | CrewAI | OpenAI Agents SDK | Vercel AI SDK |
|---|---|---|---|---|---|
| Language | TypeScript | Python/JS | Python | Python/JS | TypeScript |
| Provider lock-in | None (BYOK) | Low | Low | Optimized for OpenAI | Low |
| Agent patterns | 4 (reactive, pipeline, router, supervisor) | Graph-based | Role-based crews | Handoffs | Single-agent |
| A2A protocol | Native | No | No | No | No |
| MCP support | Native (client + server) | Plugin | No | Client only | No |
| Multi-tenant | Built-in | No | No | No | No |
| Thread/Run separation | Yes | No | No | Sessions | No |
| Plan review (HITL) | Structured | Graph interrupts | No | Basic | Tool approval |
| Persona inheritance | Yes | No | Role strings | Instructions | System prompt |
| Progressive tool loading | Yes | No | No | No | No |
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
import { defineAgent, defineTool, ProviderFactory } from '@namzu/sdk'
import { z } from 'zod'

// Define a tool
const searchWeb = defineTool({
  name: 'search_web',
  description: 'Search the web for information',
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => {
    const results = await fetch(`https://api.search.com?q=${query}`)
    return { success: true, output: await results.text() }
  },
})

// Create a provider
const provider = ProviderFactory.createProvider({
  type: 'openrouter',
  apiKey: process.env.OPENROUTER_KEY!,
  model: 'anthropic/claude-sonnet-4-20250514',
})

// Define an agent
const agent = defineAgent({
  info: {
    id: 'researcher',
    name: 'Research Assistant',
    version: '1.0.0',
    category: 'research',
    description: 'Finds and synthesizes information from the web',
    tools: ['search_web'],
    defaults: { model: 'anthropic/claude-sonnet-4-20250514', tokenBudget: 8192 },
  },
  tools: [searchWeb],
})
```

## Agent Types

Namzu provides four agent orchestration patterns, each designed for different execution models.

### Reactive Agent

The core agentic loop. Sends messages to an LLM, executes tool calls, and iterates until the task is complete or a stop condition is hit (token budget, cost limit, timeout, max iterations).

```typescript
import { ReactiveAgent } from '@namzu/sdk'

const agent = new ReactiveAgent({ id: 'solver', name: 'Problem Solver' })
const result = await agent.run(
  { messages: [{ role: 'user', content: 'Analyze this dataset and find trends' }] },
  { provider, tools, systemPrompt: 'You are a data analyst.' },
)
```

### Pipeline Agent

Deterministic, sequential step execution. Each step receives the output of the previous one. Supports rollback on failure.

```typescript
import { PipelineAgent } from '@namzu/sdk'

const etl = new PipelineAgent({ id: 'etl', name: 'ETL Pipeline' })
const result = await etl.run(input, {
  steps: [
    { name: 'extract', execute: async (inp) => await readSource(inp.path) },
    { name: 'transform', execute: async (data) => normalize(data) },
    { name: 'load', execute: async (data) => await writeToDb(data) },
  ],
})
```

### Router Agent

Intelligent delegation. An LLM analyzes the input and routes it to the best-suited agent from a set of candidates.

```typescript
import { RouterAgent } from '@namzu/sdk'

const router = new RouterAgent({ id: 'dispatcher', name: 'Task Router' })
const result = await router.run(input, {
  provider,
  routes: [
    { agentId: 'math-solver', agent: mathAgent, description: 'Solves equations' },
    { agentId: 'writer', agent: writerAgent, description: 'Writes content' },
  ],
  fallbackAgentId: 'writer',
})
```

### Supervisor Agent

Multi-agent coordinator. Manages child agents, delegates tasks, aggregates results, and tracks the full run hierarchy.

```typescript
import { SupervisorAgent, AgentManager } from '@namzu/sdk'

const supervisor = new SupervisorAgent({ id: 'lead', name: 'Project Lead' })
const result = await supervisor.run(input, {
  provider,
  agentManager,
  agentDefinitions: [researcherDef, writerDef, reviewerDef],
})
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

Built-in tools: `ReadFileTool`, `WriteFileTool`, `BashTool`, `GlobTool`, `SearchToolsTool`

## Providers

Pluggable LLM backends with a unified interface for chat, streaming, and model discovery.

```typescript
import { ProviderFactory, OpenRouterProvider, BedrockProvider } from '@namzu/sdk'

// OpenRouter (BYOK)
const openrouter = ProviderFactory.createProvider({
  type: 'openrouter',
  apiKey: process.env.OPENROUTER_KEY!,
  model: 'anthropic/claude-sonnet-4-20250514',
})

// AWS Bedrock
const bedrock = ProviderFactory.createProvider({
  type: 'bedrock',
  region: 'us-east-1',
  model: 'anthropic.claude-3-sonnet-20240229-v1:0',
})

// Streaming
for await (const chunk of provider.chatStream(params)) {
  process.stdout.write(chunk.delta?.content ?? '')
}

// Model discovery
const models = await provider.listModels()
```

## RAG

End-to-end retrieval-augmented generation: chunk documents, embed them, store and search vectors, and inject context into agent prompts.

```typescript
import {
  TextChunker,
  OpenRouterEmbeddingProvider,
  InMemoryVectorStore,
  DefaultRetriever,
  DefaultIngestionPipeline,
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
const retriever = new DefaultRetriever(vectorStore)

// Knowledge base
const kb = new DefaultKnowledgeBase({ retriever, ingestionPipeline })
await kb.ingest({ id: 'doc-1', title: 'API Guide', content: apiDoc })
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
  ConnectorRegistry,
  MCPClient,
  MCPConnectorBridge,
  TenantConnectorManager,
} from '@namzu/sdk'

// HTTP connector
const slack = new HttpConnector({
  id: 'slack',
  baseUrl: 'https://slack.com/api',
  methods: [
    { name: 'send_message', path: '/chat.postMessage', httpMethod: 'POST' },
  ],
})

// MCP client (stdio or HTTP-SSE transport)
const mcpClient = new MCPClient({
  serverName: 'my-tools',
  transport: { type: 'stdio', command: 'node', args: ['server.js'] },
})
await mcpClient.connect()
const tools = await mcpClient.listTools()
const result = await mcpClient.callTool('my_tool', { input: 'value' })

// Bridge MCP tools into Namzu tool system
const bridge = new MCPConnectorBridge(mcpClient)
const namzuTools = bridge.toToolDefinitions()

// Multi-tenant isolation
const tenantManager = new TenantConnectorManager({
  connectorRegistry,
  tenantId: 'org-123',
})
```

## Human-in-the-Loop

Pause agent execution for human review of plans and tool calls. Checkpoint and resume runs across sessions.

```typescript
import { PlanManager } from '@namzu/sdk'

const planManager = new PlanManager(runId, async (request) => {
  if (request.type === 'plan_approval') {
    // Present plan to user, get approval
    const userDecision = await showPlanUI(request.plan)
    return { approved: userDecision.approved }
  }

  if (request.type === 'tool_review') {
    // Review tool calls before execution
    const hasDestructive = request.toolCalls.some((t) => t.isDestructive)
    if (hasDestructive) {
      return { approved: false, feedback: 'Destructive tool blocked' }
    }
    return { approved: true }
  }

  return { action: 'continue' }
})
```

Checkpoint/resume enables long-running agents to pause and restart without losing state.

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

// Convert inbound A2A message to a Namzu run
const runParams = a2aMessageToCreateRun(agentId, a2aMessage)

// Convert completed run to A2A task response
const a2aTask = runToA2ATask(run, messages)
```

## Streaming (SSE)

Map internal agent execution events to Server-Sent Events for real-time client updates.

```typescript
import { mapRunToStreamEvent } from '@namzu/sdk'

// 28 event types: run.*, iteration.*, tool.*, message.*, plan.*, agent.*, task.*
agent.on('event', (event) => {
  const sseEvent = mapRunToStreamEvent(event, runId)
  if (sseEvent) {
    response.write(`event: ${sseEvent.wire}\ndata: ${JSON.stringify(sseEvent.data)}\n\n`)
  }
})
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

// Load full skill content on demand
const skill = await registry.load('web-search', 'full')

// Resolve inheritance: category skills + agent-specific overrides
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

The `ConversationStore` interface is pluggable — swap in SQLite, Postgres, or any backend. The SDK ships with `InMemoryConversationStore` as the default.

## Persistence

In-memory and disk-backed stores for runs, tasks, conversations, and activities.

```typescript
import { RunPersistence, DiskTaskStore, InMemoryConversationStore } from '@namzu/sdk'

// Run persistence with token/cost tracking
const persistence = new RunPersistence({
  runId,
  agentId,
  outputDir: './runs',
  sessionConfig: { model: 'claude-3', temperature: 0.7 },
})
await persistence.init()
persistence.accumulateUsage({ promptTokens: 100, completionTokens: 50 })
await persistence.persist()

// Multi-tenant task store with atomic writes
const taskStore = new DiskTaskStore({
  baseDir: './tasks',
  defaultRunId: runId,
  tenantId: 'org-1',
})
```

## Telemetry

OpenTelemetry integration for distributed tracing and metrics across agents, tools, and providers.

```typescript
import { initTelemetry, getTracer, getMeter, createPlatformMetrics } from '@namzu/sdk'

initTelemetry({
  serviceName: 'agent-platform',
  traceExporter: { endpoint: 'http://localhost:4318/v1/traces' },
  metricsExporter: { endpoint: 'http://localhost:4318/v1/metrics' },
})

const tracer = getTracer()
const metrics = createPlatformMetrics()

const span = tracer.startSpan('agent.run')
metrics.tokenCounter.add(150, { agent_id: 'researcher', model: 'claude-3' })
span.end()
```

## Architecture

```
@namzu/sdk
├── agents/          Reactive, Pipeline, Router, Supervisor
├── bridge/          A2A protocol, SSE mapping, connector tools
├── config/          Runtime configuration with Zod schemas
├── connector/       HTTP, webhook, MCP client/server, tenant isolation
├── contracts/       API wire types and validation schemas
├── gateway/         Local task gateway
├── manager/         Plan lifecycle, agent coordination, run persistence
├── persona/         System prompt assembly and merging
├── provider/        OpenRouter, Bedrock, Mock LLM providers
├── rag/             Chunking, embedding, vector store, retrieval
├── registry/        Agent, tool, and managed registries
├── runtime/         Query engine, decision parser, context cache
├── skills/          Skill registry, discovery, and chaining
├── store/           In-memory, disk, conversation, activity stores
├── telemetry/       OpenTelemetry tracing and metrics
├── tools/           defineTool, built-in tools, task tools
├── types/           Full type system (57 files)
├── utils/           ID generation, cost calc, hashing, logging
└── vault/           Credential management
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
