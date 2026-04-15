<p align="center">
  <h1 align="center">Namzu</h1>
  <p align="center">
    <strong>Open-source AI agent SDK with a built-in runtime. Nothing between you and your agents.</strong>
  </p>
  <p align="center">
    <a href="https://github.com/cogitave/namzu/blob/main/LICENSE.md"><img src="https://img.shields.io/badge/license-FSL--1.1--MIT-blue" alt="License" /></a>
    <a href="https://www.npmjs.com/package/@namzu/sdk"><img src="https://img.shields.io/npm/v/@namzu/sdk" alt="npm" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node" /></a>
    <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.5+-3178C6" alt="TypeScript" /></a>
  </p>
</p>

---

Namzu is a TypeScript SDK that gives you everything to build and run AI agents — a full runtime with process-level sandbox isolation, composable tools, and first-class [MCP](https://modelcontextprotocol.io) + [A2A](https://google.github.io/A2A) protocol support. No vendor lock-in, no black boxes. You choose the model, you control the runtime, you own the stack.

## Why Namzu

Most agent frameworks give you an LLM wrapper with tool calling. Namzu gives you an **agent runtime**:

- **Sandboxed execution** — Agents run tools inside process-level sandboxes (macOS Seatbelt, Linux namespaces). File writes, shell commands, and code execution are isolated by default. No container overhead.
- **Multi-model, single interface** — Write once, run on any model. Swap between OpenRouter (100+ models) and AWS Bedrock without changing a line of agent code.
- **Protocol-native** — MCP tool servers and A2A agent-to-agent communication are built into the core, not bolted on as plugins.
- **Multi-tenant isolation** — Designed for SaaS from day one. Tenant boundaries, credential vaults, and resource isolation are first-class primitives.
- **Convention-driven** — Branded IDs, exhaustive type switches, deny-by-default error handling. The SDK enforces patterns that prevent entire categories of bugs.

## Quick Start

```bash
pnpm add @namzu/sdk
```

```typescript
import {
  ReactiveAgent,
  defineAgent,
  query,
  ProviderFactory,
  getBuiltinTools,
} from '@namzu/sdk'

// Create a provider (OpenRouter, Bedrock, or your own)
const provider = ProviderFactory.create({
  kind: 'openrouter',
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: 'anthropic/claude-sonnet-4-20250514',
})

// Define an agent
const agent = defineAgent({
  id: 'agt_assistant',
  name: 'Assistant',
  kind: 'reactive',
  description: 'A sandboxed coding assistant',
  model: 'anthropic/claude-sonnet-4-20250514',
  systemPrompt: 'You are a helpful coding assistant.',
})

// Run a query with built-in tools
const result = await query({
  agent,
  provider,
  tools: getBuiltinTools(),
  messages: [{ role: 'user', content: 'List the files in the current directory' }],
})
```

## Architecture

Monorepo with a strict dependency direction:

```
@namzu/contracts  (leaf — shared types & API contracts)
       ^
@namzu/sdk        (core — runtime, tools, providers, sandbox)
       ^
@namzu/agents | @namzu/api | @namzu/cli  (apps)
```

### Core SDK Structure

```
src/
 ├── runtime/        Query executor, iteration phases, decision parsing
 ├── sandbox/        Process-level isolation (seatbelt, namespace)
 ├── tools/          Built-in tools + defineTool() factory
 ├── provider/       LLM providers (OpenRouter, Bedrock)
 ├── agents/         Agent types (Reactive, Pipeline, Router, Supervisor)
 ├── connector/      MCP client + HTTP/Webhook connectors
 ├── bridge/         A2A + SSE + MCP server bridges
 ├── persona/        YAML persona system with inheritance
 ├── rag/            Chunking, embedding, vector search
 ├── plugin/         Plugin lifecycle + discovery
 ├── registry/       Type-safe registries (agent, tool, connector, plugin)
 ├── manager/        Run persistence, emergency save, plan management
 ├── store/          Conversation, memory, task, activity, run stores
 ├── telemetry/      OpenTelemetry traces + metrics
 ├── vault/          Credential storage
 └── types/          30+ type modules with branded IDs
```

## Sandbox

Agents execute tools inside process-level sandboxes. No Docker required.

```typescript
import { query, SandboxProviderFactory } from '@namzu/sdk'

const sandboxProvider = SandboxProviderFactory.create({ provider: 'local' })

const result = await query({
  agent,
  provider,
  tools: getBuiltinTools(),
  messages,
  sandboxProvider, // tools auto-route through sandbox
})
```

**How it works:**

| Platform | Mechanism | Isolation |
|----------|-----------|-----------|
| macOS | `sandbox-exec` with Seatbelt (SBPL) profiles | Deny-default, allow-back for agent workspace |
| Linux | Namespace isolation | Process + filesystem isolation |

The sandbox provides:
- **File I/O** — `readFile()`, `writeFile()` scoped to agent workspace
- **Process execution** — `exec()` runs commands in the sandbox with timeout and signal control
- **Automatic lifecycle** — Created before query, destroyed after (with cleanup)

All built-in tools are sandbox-aware. When a sandbox is present, tools route through `sandbox.exec()` / `sandbox.readFile()` / `sandbox.writeFile()` automatically. When no sandbox is present, they fall back to native operations.

## Built-in Tools

Namzu ships 8 tools out of the box, matching capabilities expected by modern AI agents:

| Tool | Description |
|------|-------------|
| **Bash** | Execute shell commands with timeout and sandbox support |
| **ReadFile** | Read files with offset/limit for large file handling |
| **WriteFile** | Write files with automatic directory creation |
| **Edit** | Surgical find-and-replace editing with uniqueness validation |
| **Glob** | File pattern matching (`**/*.ts`, `src/**/*.test.*`) |
| **Grep** | Regex content search with context lines and file filtering |
| **Ls** | Directory listing with sizes, depth control, hidden files |
| **SearchTools** | Dynamic tool discovery and loading |

All tools are defined with `defineTool()` and include Zod input schemas for runtime validation.

## Providers

Swap model providers without changing agent code:

```typescript
// OpenRouter — access 100+ models
const openrouter = ProviderFactory.create({
  kind: 'openrouter',
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: 'anthropic/claude-sonnet-4-20250514',
})

// AWS Bedrock — run in your own cloud
const bedrock = ProviderFactory.create({
  kind: 'bedrock',
  region: 'us-east-1',
  model: 'anthropic.claude-sonnet-4-20250514-v1:0',
})
```

Implement `LLMProvider` interface to add your own.

## Agent Types

| Type | Use Case |
|------|----------|
| **ReactiveAgent** | Single-turn tool-use loops (most common) |
| **PipelineAgent** | Sequential multi-step workflows |
| **RouterAgent** | Routes tasks to specialized sub-agents by model/capability |
| **SupervisorAgent** | Orchestrates multiple agents with delegation and oversight |

## Protocols

### MCP (Model Context Protocol)

Connect to any MCP tool server:

```typescript
import { McpConnector } from '@namzu/sdk'

const connector = new McpConnector({
  id: 'con_filesystem',
  transport: { type: 'stdio', command: 'npx', args: ['-y', '@anthropic/mcp-filesystem'] },
})

// Tools from MCP servers are automatically available to agents
```

### A2A (Agent-to-Agent)

Expose agents as A2A-compatible services:

```typescript
import { buildAgentCard } from '@namzu/sdk'

const card = buildAgentCard({
  agent,
  url: 'https://api.example.com/agents/assistant',
  capabilities: { streaming: true },
})
```

## Configuration

All configuration is schema-validated with Zod:

```typescript
import { RuntimeConfigSchema } from '@namzu/sdk'

const config = RuntimeConfigSchema.parse({
  provider: { kind: 'openrouter', apiKey: '...' },
  sandbox: { enabled: true, provider: 'local', timeoutMs: 30_000 },
  telemetry: { enabled: true, serviceName: 'my-app' },
  compaction: { enabled: true, strategy: 'working-state' },
})
```

Configuration follows [12-factor](https://12factor.net/config) — secrets come from environment variables, never hardcoded.

## Development

```bash
# Prerequisites: Node >= 20, pnpm >= 9
pnpm install

# Build all packages
pnpm build

# Type check
pnpm typecheck

# Lint
pnpm lint

# Run tests
pnpm test
```

## License

[FSL-1.1-MIT](LICENSE.md) — Functional Source License with MIT future. Free for internal use, education, and research. Converts to MIT after two years.

Built by [Cogitave](https://github.com/cogitave).
