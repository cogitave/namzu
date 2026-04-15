<div align="center">

<h1>Namzu</h1>

Open-source AI agent SDK with a built-in runtime. Nothing between you and your agents.

[![License: FSL-1.1-MIT](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](./LICENSE.md)
[![npm version](https://img.shields.io/npm/v/@namzu/sdk.svg)](https://www.npmjs.com/package/@namzu/sdk)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![TypeScript 5.5+](https://img.shields.io/badge/typescript-5.5%2B-3178c6.svg)](https://www.typescriptlang.org)

</div>

---

Namzu is a TypeScript monorepo that ships an agent SDK with a built-in runtime and a family of per-vendor LLM provider packages. The design is a tiny brand-neutral core (`@namzu/sdk`) plus opt-in providers and capability packages — installing the SDK alone pulls no vendor SDKs, and each provider is added by a deliberate `pnpm add`. Heavy vendor dependencies (AWS, Anthropic, OpenAI, LM Studio, Ollama) live in separate packages and are loaded only when the application registers them.

## Quick Start

Install the SDK and a provider package. The SDK itself ships no vendor SDKs — you pull in the backend(s) you need.

```bash
pnpm add @namzu/sdk @namzu/ollama
```

Minimal working example: register Ollama, create a provider, make one chat call.

```typescript
import { ProviderRegistry, createUserMessage } from '@namzu/sdk'
import { registerOllama } from '@namzu/ollama'

registerOllama()

const { provider } = ProviderRegistry.create({
  type: 'ollama',
  host: 'http://localhost:11434',
})

const response = await provider.chat({
  model: 'llama3.2',
  messages: [createUserMessage('What is the capital of France?')],
})

console.log(response.message.content)
console.log(`finish: ${response.finishReason}`)
```

The response shape is `{ id, model, message: { role, content, toolCalls? }, finishReason, usage }` — content lives at `response.message.content`, not `response.content`.

## Provider Selection

| Backend    | Install                                 | Key config fields                                            |
|------------|-----------------------------------------|--------------------------------------------------------------|
| OpenAI     | `pnpm add @namzu/sdk @namzu/openai`     | `apiKey`, `model?`, `baseURL?`, `organization?`, `project?`  |
| Anthropic  | `pnpm add @namzu/sdk @namzu/anthropic`  | `apiKey`, `model?`, `baseURL?`, `maxTokens?`                 |
| Bedrock    | `pnpm add @namzu/sdk @namzu/bedrock`    | `region?`, `accessKeyId?`, `secretAccessKey?`, `sessionToken?` |
| OpenRouter | `pnpm add @namzu/sdk @namzu/openrouter` | `apiKey`, `baseUrl?`, `siteUrl?`, `siteName?`                |
| Ollama     | `pnpm add @namzu/sdk @namzu/ollama`     | `host?`, `model?`, `fetch?`, `timeout?`                      |
| LM Studio  | `pnpm add @namzu/sdk @namzu/lmstudio`   | `host?`, `model?`, `timeout?`                                |
| HTTP       | `pnpm add @namzu/sdk @namzu/http`       | `baseURL`, `apiKey?`, `dialect?` (`'openai'` \| `'anthropic'`), `headers?` |
| Mock       | `pnpm add @namzu/sdk` (built-in)        | `model?`, `responseText?`, `responseDelayMs?`                |

Every provider package exports a `register<Vendor>()` function that augments the SDK's `ProviderConfigRegistry` type with a `type: '<vendor>'` discriminator, so `ProviderRegistry.create({ type: 'openai', apiKey: ... })` is fully type-narrowed.

## Core Concepts

### LLMProvider and ProviderRegistry

Providers implement a narrow `LLMProvider` interface (`chat`, `chatStream`, optionally `listModels`, `healthCheck`). The `ProviderRegistry` is a process-global map from a type string to a constructor + capability record. Provider packages self-register through `register<Vendor>()`; you pick one at call time.

```typescript
import { ProviderRegistry } from '@namzu/sdk'
import { registerOpenAI } from '@namzu/openai'

registerOpenAI()

const { provider, capabilities } = ProviderRegistry.create({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY as string,
})

console.log(capabilities.supportsTools, capabilities.supportsStreaming)
```

`ProviderRegistry.create(config)` returns `{ provider, capabilities }`. Use `ProviderRegistry.register(type, Class, capabilities, options?)` to wire a custom provider.

### Agents

Five agent shapes ship in the SDK: `AbstractAgent`, `ReactiveAgent`, `PipelineAgent`, `RouterAgent`, `SupervisorAgent`, plus the `defineAgent()` factory. `ReactiveAgent` is the common case — a tool-calling loop around a single provider.

```typescript
import { ReactiveAgent } from '@namzu/sdk'

const agent = new ReactiveAgent({
  id: 'agent_demo',
  name: 'demo',
  description: 'Demo reactive agent',
  version: '0.1.0',
})
```

Call `agent.run(input, config)` where `config` is a `ReactiveAgentConfig` carrying `provider`, `tools`, `model`, `threadId`, etc. See `packages/sdk/src/types/agent/` for full shapes.

### Tools

The SDK ships eight built-in tool classes — `ReadFileTool`, `WriteFileTool`, `EditTool`, `BashTool`, `GlobTool`, `GrepTool`, `LsTool`, `SearchToolsTool` — and a `defineTool()` helper for custom ones.

```typescript
import { z } from 'zod'
import { ToolRegistry, ReadFileTool, BashTool, defineTool } from '@namzu/sdk'

const tools = new ToolRegistry()
tools.register(ReadFileTool)
tools.register(BashTool)

const greet = defineTool({
  name: 'greet',
  description: 'Greet someone.',
  inputSchema: z.object({ name: z.string() }),
  category: 'custom',
  permissions: [],
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  async execute(input) {
    return { success: true, output: `Hello, ${input.name}!` }
  },
})
tools.register(greet)
```

### Runtime

`query(params)` is the core event-yielding generator; `drainQuery(params, listener?)` awaits it to completion and returns the final `AgentRun`. `QueryParams` has roughly 25 fields — most are optional; `provider`, `tools`, `runConfig`, `agentId`, `agentName`, `threadId`, and `messages` are required. See `packages/sdk/src/runtime/query/index.ts` for the full interface; most callers use the agent classes instead of invoking `drainQuery` directly.

### Stores

`InMemoryTaskStore` and `DiskTaskStore` persist task objects; `InMemoryMemoryStore` / `DiskMemoryStore` persist agent memory; `InMemoryVectorStore` backs RAG.

```typescript
import { DiskTaskStore } from '@namzu/sdk'
import type { RunId } from '@namzu/sdk'

const taskStore = new DiskTaskStore({
  baseDir: './.namzu/tasks',
  defaultRunId: 'run_root' as RunId,
})
```

### Sandbox

`LocalSandboxProvider` creates ephemeral working directories for tool execution (Bash, file edits). It takes a `Logger` and returns a `SandboxProvider` the runtime can bind to a run. `SandboxProviderFactory` picks an implementation from a `SandboxConfig`.

```typescript
import { LocalSandboxProvider, getRootLogger } from '@namzu/sdk'

const sandboxProvider = new LocalSandboxProvider(getRootLogger())
```

## Examples

### Example 1 — Bare provider call

```typescript
import { ProviderRegistry, createUserMessage } from '@namzu/sdk'
import { registerOllama } from '@namzu/ollama'

registerOllama()

const { provider } = ProviderRegistry.create({
  type: 'ollama',
  host: 'http://localhost:11434',
})

const response = await provider.chat({
  model: 'llama3.2',
  messages: [createUserMessage('What is the capital of France?')],
})

console.log(response.message.content)
```

### Example 2 — Streaming

`chatStream()` returns an `AsyncIterable<StreamChunk>`. Each chunk carries `delta.content` (partial text) or `delta.toolCalls`; `finishReason` only appears on the terminal chunk.

```typescript
import { ProviderRegistry, createUserMessage } from '@namzu/sdk'
import { registerOllama } from '@namzu/ollama'

registerOllama()

const { provider } = ProviderRegistry.create({
  type: 'ollama',
  host: 'http://localhost:11434',
})

const stream = provider.chatStream({
  model: 'llama3.2',
  messages: [createUserMessage('Stream me a limerick.')],
})

for await (const chunk of stream) {
  if (chunk.delta.content) {
    process.stdout.write(chunk.delta.content)
  }
  if (chunk.finishReason) {
    process.stdout.write(`\n[done: ${chunk.finishReason}]\n`)
  }
}
```

### Example 3 — Multi-provider fallback

Register two providers and pick based on which credentials are present. The same `ChatCompletionParams` shape works for both.

```typescript
import { ProviderRegistry, createUserMessage } from '@namzu/sdk'
import { registerAnthropic } from '@namzu/anthropic'
import { registerOpenRouter } from '@namzu/openrouter'

registerAnthropic()
registerOpenRouter()

const useAnthropic = Boolean(process.env.ANTHROPIC_API_KEY)

const { provider } = useAnthropic
  ? ProviderRegistry.create({
      type: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY as string,
    })
  : ProviderRegistry.create({
      type: 'openrouter',
      apiKey: process.env.OPENROUTER_API_KEY as string,
      siteName: 'my-app',
    })

const model = useAnthropic ? 'claude-sonnet-4-5' : 'anthropic/claude-sonnet-4'

const response = await provider.chat({
  model,
  messages: [createUserMessage('Hello!')],
  maxTokens: 256,
})

console.log(response.message.content)
```

## Repository Layout

```
namzu/
├── packages/
│   ├── sdk/                       @namzu/sdk           0.1.7   published
│   ├── computer-use/              @namzu/computer-use  0.1.0   published
│   ├── providers/
│   │   ├── anthropic/             @namzu/anthropic     0.1.0   unpublished
│   │   ├── bedrock/               @namzu/bedrock       0.1.0   unpublished
│   │   ├── http/                  @namzu/http          0.1.0   unpublished
│   │   ├── lmstudio/              @namzu/lmstudio      0.1.0   unpublished
│   │   ├── ollama/                @namzu/ollama        0.1.0   unpublished
│   │   ├── openai/                @namzu/openai        0.1.0   unpublished
│   │   ├── openrouter/            @namzu/openrouter    0.1.0   unpublished
│   │   └── PUBLISH_CHECKLIST.md
│   ├── contracts/                                              local-only (gitignored)
│   ├── agents/                                                 local-only (gitignored)
│   ├── api/                                                    local-only (gitignored)
│   ├── cli/                                                    local-only (gitignored)
│   └── docs/                                                   local-only (gitignored)
├── docs/architecture/decisions/   ADRs (public)
├── docs.local/                    detailed pattern + convention docs (gitignored)
├── .github/workflows/             per-package release-*.yml + ci.yml
├── AGENTS.md  CLAUDE.md           AI-tool guidance
└── LICENSE.md
```

Status markers:

- **published** — on npm under `@namzu/*`.
- **unpublished** — tracked, tested, committed; npm publication pending (see Project Status).
- **local-only (gitignored)** — exists on the maintainer's machine, excluded from the public repo via `.gitignore`. Not on npm.

## Architecture

`@namzu/sdk` is the core and has no workspace dependencies. Provider and capability packages depend on the SDK via a `peerDependencies` entry on `@namzu/sdk`; nothing in the SDK depends back on them.

```
                ┌────────────────────────────────────────┐
                │              @namzu/sdk                │
                │                                        │
                │  • LLMProvider interface               │
                │  • ProviderRegistry (register/create)  │
                │  • MockLLMProvider (pre-registered)    │
                │  • runtime, agents, tools, personas    │
                └────────────────────────────────────────┘
                    ▲                               ▲
                    │ peerDependency                │ peerDependency
                    │                               │
    ┌───────────────┴──────────────────┐   ┌────────┴────────────┐
    │      Provider packages           │   │ Capability packages │
    │                                  │   │                     │
    │  @namzu/anthropic  @namzu/openai │   │  @namzu/computer-use│
    │  @namzu/bedrock    @namzu/openrouter                       │
    │  @namzu/http       @namzu/ollama │   │                     │
    │  @namzu/lmstudio                 │   │                     │
    └──────────────────────────────────┘   └─────────────────────┘
```

Concrete contract points (verified in source):

- `@namzu/sdk` exports the `LLMProvider` interface (via `src/types/provider/`) and the `ProviderRegistry` class plus `UnknownProviderError` / `DuplicateProviderError` (via `src/provider/`). Both are re-exported from the root barrel.
- Each provider package declares `"@namzu/sdk": "^1 || ^0.1.6"` under `peerDependencies`.
- Each provider package exports a `register<Vendor>()` function that calls `ProviderRegistry.register(type, Class, capabilities, options)`. Providers use TypeScript module augmentation (`declare module '@namzu/sdk'`) to extend `ProviderConfigRegistry`, giving callers type-narrowed config.
- `@namzu/computer-use` is a separate capability package implementing a subprocess-based `ComputerUseHost` for the contract in `@namzu/sdk` (platform-native CLIs: `screencapture`/`osascript` on darwin, `xdotool`/`maim` on X11, `grim`/`wtype`/`ydotool` on Wayland, PowerShell on Windows).
- Dependency direction is strictly downward: `@namzu/sdk` does not import any `@namzu/*` workspace package.

**Note on SDK footprint.** Published `@namzu/sdk@0.1.7` still carries `zod`, `zod-to-json-schema`, and eight `@opentelemetry/*` runtime dependencies. ADR-0001 describes a zod-plus-interface target footprint; that reduction is not yet applied in `0.1.x`.

## Release Flow

Every published package has its own release workflow in `.github/workflows/`, keyed off a tag prefix:

| Tag prefix        | Workflow                       | Publishes                  |
|-------------------|--------------------------------|----------------------------|
| `sdk-v*`          | `release-sdk.yml`              | `@namzu/sdk`               |
| `computer-use-v*` | `release-computer-use.yml`     | `@namzu/computer-use`      |
| `anthropic-v*`    | `release-anthropic.yml`        | `@namzu/anthropic`         |
| `bedrock-v*`      | `release-bedrock.yml`          | `@namzu/bedrock`           |
| `http-v*`         | `release-http.yml`             | `@namzu/http`              |
| `lmstudio-v*`     | `release-lmstudio.yml`         | `@namzu/lmstudio`          |
| `ollama-v*`       | `release-ollama.yml`           | `@namzu/ollama`            |
| `openai-v*`       | `release-openai.yml`           | `@namzu/openai`            |
| `openrouter-v*`   | `release-openrouter.yml`       | `@namzu/openrouter`        |

Publishing uses npm Trusted Publisher (OIDC) with `--provenance`. No `NPM_TOKEN` secret in the repo.

Locally, release is driven by `pnpm release:<channel>` inside each package (`patch`, `minor`, `major`, `rc`, `beta`, `stable`, `dry`). The script bumps version, commits, tags, and pushes; the corresponding GitHub Action then publishes. First-time provider publication follows `packages/providers/PUBLISH_CHECKLIST.md`.

## Project Status

- **`@namzu/sdk@0.1.7`** — latest published. `ProviderRegistry` is the current API; the older `ProviderFactory` is no longer exported. `MockLLMProvider` is pre-registered under the `'mock'` type.
- **`@namzu/computer-use@0.1.0`** — published.
- **Seven provider packages at `0.1.0`** — implemented, tested, committed: `@namzu/anthropic`, `@namzu/bedrock`, `@namzu/http`, `@namzu/lmstudio`, `@namzu/ollama`, `@namzu/openai`, `@namzu/openrouter`. **Not yet on npm.** Publication is the next batched step per `packages/providers/PUBLISH_CHECKLIST.md`.
- **Five packages local-only** — `contracts`, `agents`, `api`, `cli`, `docs` are gitignored, not part of the public release surface today.

Roadmap direction (see ADR-0001 for the vendor-split rationale):

- A `1.0.0` boundary for `@namzu/sdk` is discussed in ADR-0001 in the context of provider peer-range operability (`"@namzu/sdk": "^1 || ^0.1.6"`). No date committed.
- A future `@namzu/telemetry` package for observability — scoped internally, not yet shipped. OpenTelemetry primitives (`TelemetryProvider`, `initTelemetry`, `getTracer`) are currently exported from `@namzu/sdk` itself.
- Eventual publication of currently-local packages as they stabilise.

## Documentation

- **`docs/architecture/decisions/`** — public ADRs. Today: `0001-per-vendor-provider-extraction.md`.
- **`AGENTS.md`** / **`CLAUDE.md`** — canonical AI-tool guidance for the monorepo.
- **`docs.local/`** — detailed pattern docs and conventions. Local-only.
- **Per-package READMEs** — each package has its own with install, config, and vendor-specific notes.

## Contributing

Issues and PRs welcome at [cogitave/namzu](https://github.com/cogitave/namzu). See `packages/sdk/CONTRIBUTING.md` for local setup and conventions.

## License

[FSL-1.1-MIT](./LICENSE.md). The Functional Source License converts to MIT two years after each release, so every published version of Namzu becomes MIT-licensed on its second anniversary.
