<div align="center">

<h1>Namzu</h1>

<p><strong>Open-source AI agent SDK with a built-in runtime. Nothing between you and your agents.</strong></p>

<p>
  <a href="https://github.com/cogitave/namzu/blob/main/LICENSE.md"><img alt="License: FSL-1.1-MIT" src="https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg" /></a>
  <a href="https://www.npmjs.com/package/@namzu/sdk"><img alt="npm version" src="https://img.shields.io/npm/v/@namzu/sdk.svg?label=%40namzu%2Fsdk" /></a>
  <a href="https://nodejs.org/"><img alt="Node >= 20" src="https://img.shields.io/badge/node-%3E%3D20-339933.svg?logo=node.js&logoColor=white" /></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript 5.5+" src="https://img.shields.io/badge/typescript-5.5%2B-3178C6.svg?logo=typescript&logoColor=white" /></a>
</p>

</div>

---

Namzu is a TypeScript-native agent platform: an SDK, a runtime, and a small set of protocol integrations shipped as one coherent stack. It sits alongside LangChain, Mastra, and the Vercel AI SDK in the agent-framework space — but with an opinionated runtime, process-level sandboxing, and first-class MCP/A2A support baked into core instead of bolted on. The core philosophy is simple: a **zero-dep core** with **opt-in providers**. Install `@namzu/sdk` and nothing ships with it except a mock LLM; reach for vendor packages — `@namzu/openai`, `@namzu/anthropic`, `@namzu/ollama`, `@namzu/http` — only when you want them.

## Why Namzu

- **Sandboxed agent execution.** Agents run in isolated processes with platform-native sandboxing — macOS Seatbelt profiles and Linux user namespaces — so a compromised or drifting agent can't escape its declared filesystem, network, or subprocess boundary. Sandboxing is on by default, not a checkbox.
- **Provider-agnostic via a typed registry.** `ProviderRegistry` is the single indirection between your agent code and any LLM backend. Swap OpenAI for Bedrock for local Ollama by changing one `register*()` call at startup — agents keep consuming the `LLMProvider` interface and never know the difference. `MockLLMProvider` ships pre-registered in core for tests and offline work.
- **Protocol-native MCP and A2A.** Model Context Protocol (tool servers) and Agent-to-Agent (peer orchestration) are not plugins — they're first-class surfaces in `@namzu/sdk`. Expose an agent as an MCP server, consume an MCP tool server, or federate work across A2A peers without pulling a separate package.
- **Multi-tenant isolation for SaaS.** Tenant boundaries are enforced end-to-end: credential vaults, run scoping, and event streams all carry tenant identity as a branded ID. The same SDK that powers a solo-dev CLI also powers multi-tenant platforms without a rewrite.
- **Convention-driven TypeScript.** Branded IDs for every resource handle, exhaustive `never`-assertion switches on discriminated unions, and deny-by-default error handling are project-wide conventions — not style preferences. The compiler catches the class of bugs most agent frameworks defer to runtime.
- **Local-first LLM story.** `@namzu/ollama`, `@namzu/lmstudio`, and `@namzu/http` make running agents against local models — or any self-hosted OpenAI/Anthropic-compatible endpoint (vLLM, TGI, llama-server, Groq, DeepInfra) — a first-class path, not an afterthought.
- **Tiny core.** `@namzu/sdk` pulls almost no runtime dependencies. Heavy vendor SDKs (`@aws-sdk/*`, `openai`, `@anthropic-ai/sdk`, `ollama`, `@lmstudio/sdk`) live in their own per-vendor packages and install only when you ask for them.

## Quick Start

Install the core SDK plus whichever provider you want. The local-first default is Ollama — no API keys, no network, no egress:

```bash
pnpm add @namzu/sdk @namzu/ollama
```

Register the provider once at startup, then use it anywhere in your app:

```typescript
import { ProviderRegistry } from '@namzu/sdk'
import { registerOllama } from '@namzu/ollama'

// Register once at app startup. Swap this single line to change backends:
//   import { registerOpenAI }    from '@namzu/openai'    ; registerOpenAI()
//   import { registerBedrock }   from '@namzu/bedrock'   ; registerBedrock()
//   import { registerAnthropic } from '@namzu/anthropic' ; registerAnthropic()
// Agent code below stays identical — it only sees the LLMProvider interface.
registerOllama()

const { provider } = ProviderRegistry.create({
  type: 'ollama',
  host: 'http://localhost:11434',
  model: 'llama3.2',
})

const response = await provider.chat({
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'Summarize Namzu in one line.' }],
})

console.log(response.message.content)
```

That's the full loop: register a provider, create it from the registry, call `chat()`. No config files, no bootstrapping module, no service container. Swap `registerOllama()` for `registerOpenAI()` or `registerBedrock()` and the whole app runs against a different backend with zero changes below the registration line.

## Provider Selection

Pick the package that matches the backend you want. Every provider implements the same `LLMProvider` contract; agent code is portable across all of them.

| I want to use…                                                  | Install                                       | Notes |
|-----------------------------------------------------------------|-----------------------------------------------|-------|
| **OpenAI** (GPT-4o, GPT-4.1, o-series)                          | `pnpm add @namzu/sdk @namzu/openai`           | Thin wrapper over the official `openai` SDK — Chat Completions with streaming and tool use. |
| **Anthropic Claude** (Sonnet, Opus, Haiku)                      | `pnpm add @namzu/sdk @namzu/anthropic`        | Messages API via `@anthropic-ai/sdk`, full tool-use streaming. |
| **AWS Bedrock** (Claude, Nova, Llama, Mistral on AWS)           | `pnpm add @namzu/sdk @namzu/bedrock`          | Bedrock Converse API via `@aws-sdk/client-bedrock-runtime`, SigV4-signed. |
| **OpenRouter** (200+ models behind one key)                     | `pnpm add @namzu/sdk @namzu/openrouter`       | Zero-dep fetch-based; model routing and fallback built in. |
| **Local Ollama**                                                | `pnpm add @namzu/sdk @namzu/ollama`           | Talks to a local `ollama serve` — no API key, no egress. |
| **Local LM Studio**                                             | `pnpm add @namzu/sdk @namzu/lmstudio`         | Native `@lmstudio/sdk` integration with model loading API. |
| **Generic HTTP** (Groq, vLLM, TGI, llama-server, self-hosted)   | `pnpm add @namzu/sdk @namzu/http`             | Zero runtime deps — pure native `fetch`. Pick `dialect: 'openai'` or `'anthropic'` plus any `baseURL`. |
| **Testing / no network**                                        | `pnpm add @namzu/sdk`                         | `MockLLMProvider` is pre-registered in core. `ProviderRegistry.create({ type: 'mock' })` works out of the box. |

### Version status

- `@namzu/sdk` — currently `0.1.6` on npm. `1.0.0` is the planned target at the provider-extraction boundary (see [ADR-0001](docs/architecture/decisions/0001-per-vendor-provider-extraction.md)).
- Provider packages (`@namzu/openai`, `@namzu/anthropic`, `@namzu/bedrock`, `@namzu/openrouter`, `@namzu/ollama`, `@namzu/lmstudio`, `@namzu/http`) — all at `0.1.0`, batch-releasing together.
- `@namzu/computer-use` — `0.1.0` on npm, independent capability package for subprocess-based computer-use hosts.

Each package releases on its own tag-prefix (`sdk-v*`, `ollama-v*`, `openai-v*`, …) through a dedicated GitHub Action — no hand-edited `package.json` bumps, no coupled releases.

## Core Concepts

### Agents

Agents are the unit of work. `AbstractAgent` is the base class; `ReactiveAgent`, `PipelineAgent`, `RouterAgent`, and `SupervisorAgent` are the four shapes most workloads want. For anything lighter, `defineAgent` builds a minimal agent without the full reactive loop.

- **`ReactiveAgent`** — canonical prompt → LLM → tool-call → iterate loop with token/time/cost budgets, progressive tool disclosure, compaction, and checkpointing.
- **`PipelineAgent`** — deterministic sequential steps; output of step N is input of step N+1; rolls back on failure.
- **`RouterAgent`** — LLM classifies the input and delegates to the best-fit child from a configured set.
- **`SupervisorAgent`** — coordinator that spawns specialized children, tracks the parent/child hierarchy, and aggregates results.

### Runtime

`query` is the entry point for running an agent's iteration loop. It is an async generator that yields `RunEvent`s (tool calls, iteration events, plan events, cost updates) and resolves to a final run record. `drainQuery` is the batched variant — it awaits every event and returns only the final run. Every higher-level agent class is a thin wrapper on top of `drainQuery`.

### Tools

Tools are side-effectful capabilities the agent can invoke. Define one with `defineTool` — Zod schema for input, category, permission set, and an `execute` function. The runtime validates input, records activity, and enforces the permission mode on your behalf.

The SDK ships a complete set of filesystem and shell builtins: `ReadFileTool`, `WriteFileTool`, `EditTool`, `BashTool`, `GlobTool`, `GrepTool`, `LsTool`, plus `SearchToolsTool` for progressive disclosure. Higher-level builders — `buildTaskTools`, `buildMemoryTools`, `buildAdvisoryTools`, `createStructuredOutputTool`, `createComputerUseTool` — compose stateful toolsets against a store or host.

### Providers

A provider is anything that implements `LLMProvider`: a vendor SDK, a proxy, a mock. Providers register against `ProviderRegistry` by a type string (`'openai'`, `'anthropic'`, `'ollama'`, …). Each provider package exports a `register<Vendor>()` helper that does the registration for you.

```typescript
import { ProviderRegistry } from '@namzu/sdk'
import { registerOllama } from '@namzu/ollama'

registerOllama()

const { provider, capabilities } = ProviderRegistry.create({
  type: 'ollama',
  host: 'http://localhost:11434',
})
```

`ProviderRegistry.create` returns both the constructed provider and its static capabilities (`supportsTools`, `supportsStreaming`, `supportsFunctionCalling`) so your code can branch on what the vendor can actually do. `UnknownProviderError` is thrown for unregistered types; `DuplicateProviderError` on double-registration unless `{ replace: true }` is passed.

### Memory and Task Store

Runs and tasks are persisted through pluggable stores. `InMemoryTaskStore` is the default for local dev. `DiskTaskStore` writes atomic JSON files under a configurable base directory — survives process restarts, safe for crash recovery. `DiskMemoryStore` plays the same role for long-lived agent memory (facts, summaries, preferences) that outlives a thread.

### Plugins

Plugins extend the runtime with discoverable manifests: tools, advisors, skills, personas. `PluginLifecycleManager` wires discovery, loading, and the `onBeforeToolCall` / `onAfterToolCall` hook points; `discoverPlugins` walks a directory and reads each `plugin.json`.

### Sandbox

Sandboxes isolate filesystem and shell side-effects. `LocalSandboxProvider` is an in-process implementation that enforces a working-directory root and a deny-by-default policy for file I/O. `SandboxProviderFactory.create(config, log)` picks the right provider based on your `SandboxConfig.provider` discriminator. Every builtin tool routes file reads/writes through the sandbox.

## Examples

These snippets are illustrative. Consult each package's README for the exact config shapes and advanced options.

### Example 1 — Hello, agent

```typescript
import { ProviderRegistry } from '@namzu/sdk'
import { registerOllama } from '@namzu/ollama'

registerOllama()

const { provider } = ProviderRegistry.create({
  type: 'ollama',
  host: 'http://localhost:11434',
})

const response = await provider.chat({
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'In one sentence, what is Namzu?' }],
})

console.log(response.message.content)
```

### Example 2 — Agent with tools

Reactive agent reading a file and summarizing it via a built-in `ReadFileTool` and a custom `word_count` tool.

```typescript
import {
  defineTool,
  ProviderRegistry,
  ReactiveAgent,
  ReadFileTool,
  ToolRegistry,
} from '@namzu/sdk'
import { registerOllama } from '@namzu/ollama'
import { z } from 'zod'

registerOllama()

const WordCountTool = defineTool({
  name: 'word_count',
  description: 'Counts words in a string.',
  inputSchema: z.object({ text: z.string() }),
  category: 'text',
  permissions: [],
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  async execute({ text }) {
    const count = text.trim().split(/\s+/).filter(Boolean).length
    return { success: true, output: String(count) }
  },
})

const tools = new ToolRegistry()
tools.register(ReadFileTool)
tools.register(WordCountTool)

const { provider } = ProviderRegistry.create({ type: 'ollama' })

const agent = new ReactiveAgent({
  id: 'summarizer',
  name: 'File Summarizer',
  version: '1.0.0',
  category: 'filesystem',
  description: 'Reads a file and returns a one-line summary with word count.',
})

// agent.run(...) returns the final run with the LLM's result + recorded tool calls.
```

### Example 3 — Multi-provider fallback

Try Anthropic first; fall back to OpenRouter if the key isn't set. Registering multiple vendors at boot is cheap — pick per-request.

```typescript
import { ProviderRegistry } from '@namzu/sdk'
import type { LLMProvider } from '@namzu/sdk'
import { registerAnthropic } from '@namzu/anthropic'
import { registerOpenRouter } from '@namzu/openrouter'

registerAnthropic()
registerOpenRouter()

function resolveProvider(): { provider: LLMProvider; model: string } {
  if (process.env.ANTHROPIC_API_KEY) {
    const { provider } = ProviderRegistry.create({
      type: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
    })
    return { provider, model: 'claude-sonnet-4-5' }
  }
  if (process.env.OPENROUTER_API_KEY) {
    const { provider } = ProviderRegistry.create({
      type: 'openrouter',
      apiKey: process.env.OPENROUTER_API_KEY,
    })
    return { provider, model: 'anthropic/claude-sonnet-4' }
  }
  throw new Error('No provider key available (ANTHROPIC_API_KEY or OPENROUTER_API_KEY).')
}

const { provider, model } = resolveProvider()
const response = await provider.chat({
  model,
  messages: [{ role: 'user', content: 'Explain prompt caching in two sentences.' }],
})
```

### Example 4 — Persistent task state

`DiskTaskStore` persists task-tracker state atomically to disk so a long-running plan survives process restarts.

```typescript
import { DiskTaskStore } from '@namzu/sdk'
import type { RunId } from '@namzu/sdk'

const taskStore = new DiskTaskStore({
  baseDir: '.namzu/tasks',
  defaultRunId: 'run_bootstrap' as RunId,
})

// Pass `taskStore` through the agent's run options to persist plan/task events
// across restarts. Re-open the same store path on the next process start and
// resume from the last known state.
```

## Packages

Namzu is a monorepo of focused packages. The SDK ships the runtime; provider packages plug into the registry; `@namzu/computer-use` is an optional capability host.

| Package | Purpose | Version | Runtime Dep |
|---|---|---|---|
| [`@namzu/sdk`](./packages/sdk) | Core runtime, agents, tools, registry, stores, RAG, connectors. | `0.1.6` published | `zod`, `@opentelemetry/api` |
| [`@namzu/computer-use`](./packages/computer-use) | Subprocess-based computer-use host (screenshot, mouse, keyboard). | `0.1.0` published | `@namzu/sdk` (peer) |
| [`@namzu/anthropic`](./packages/providers/anthropic) | Anthropic Messages API provider (Claude). | `0.1.0` coming soon | `@anthropic-ai/sdk` |
| [`@namzu/openai`](./packages/providers/openai) | OpenAI Chat Completions provider. | `0.1.0` coming soon | `openai` |
| [`@namzu/openrouter`](./packages/providers/openrouter) | OpenRouter aggregated-model provider. | `0.1.0` coming soon | none (native fetch) |
| [`@namzu/bedrock`](./packages/providers/bedrock) | AWS Bedrock provider (Claude, Llama, Mistral on Bedrock). | `0.1.0` coming soon | `@aws-sdk/client-bedrock-runtime` |
| [`@namzu/ollama`](./packages/providers/ollama) | Local-first Ollama provider. | `0.1.0` coming soon | `ollama` |
| [`@namzu/lmstudio`](./packages/providers/lmstudio) | LM Studio local-inference provider (WebSocket). | `0.1.0` coming soon | `@lmstudio/sdk` |
| [`@namzu/http`](./packages/providers/http) | Generic HTTP provider (OpenAI- or Anthropic-compatible endpoints). | `0.1.0` coming soon | none (native fetch) |

Provider packages are scheduled for their first batch release in Phase I.10 per [ADR-0001](./docs/architecture/decisions/0001-per-vendor-provider-extraction.md); `@namzu/sdk` and `@namzu/computer-use` are already on npm.

## Architecture

Namzu is a pnpm workspace monorepo. The runtime is a single small core (`@namzu/sdk`) that depends on nothing vendor-specific. Concrete LLM providers and capability packages plug into the core through an explicit registry, and every non-core package is opt-in at install time.

```
                          ┌────────────────────────┐
                          │   @namzu/contracts     │  shared types, zero deps
                          │   (local-only today)   │  leaf package
                          └───────────┬────────────┘
                                      │
                                      ▼
                          ┌────────────────────────┐
                          │      @namzu/sdk        │  core runtime,
                          │  ProviderRegistry,     │  agents, tools,
                          │  MockLLMProvider       │  persona, streaming
                          └───────────┬────────────┘
                                      │
            ┌─────────────────────────┼────────────────────────┐
            ▼                         ▼                        ▼
  ┌───────────────────┐    ┌────────────────────┐   ┌─────────────────────┐
  │  Providers        │    │  Capabilities      │   │  Apps               │
  │  @namzu/bedrock   │    │  @namzu/computer-  │   │  @namzu/agents      │
  │  @namzu/openai    │    │    use             │   │  @namzu/api         │
  │  @namzu/anthropic │    │                    │   │  @namzu/cli         │
  │  @namzu/openrouter│    │                    │   │  (all local-only    │
  │  @namzu/ollama    │    │                    │   │   for now)          │
  │  @namzu/lmstudio  │    │                    │   │                     │
  │  @namzu/http      │    │                    │   │                     │
  └───────────────────┘    └────────────────────┘   └─────────────────────┘
```

**The three layers.** `@namzu/contracts` is a leaf package of shared types, pulled in only by other Namzu packages; it is local-only today and will publish once its API stabilizes. `@namzu/sdk` is the core runtime — agents, tools, streaming, persona, and a `ProviderRegistry` extension point that replaces the older hardcoded factory. Providers and capabilities are thin, independently versioned packages that register themselves with the SDK at app startup via explicit `register<Vendor>()` calls (see [ADR-0001](docs/architecture/decisions/0001-per-vendor-provider-extraction.md)).

Dependency direction is strictly one-way:

```
@namzu/contracts  ─►  @namzu/sdk  ─►  @namzu/{providers/*, computer-use, apps}
```

No package imports from the same level or above. Providers never import each other; apps never import from each other. Node.js `>= 20` is required across the workspace.

## Release Flow

The monorepo uses a **tag-prefix release scheme**. Each package has a dedicated GitHub Actions workflow keyed off its own tag prefix — `sdk-v*` publishes `@namzu/sdk`, `ollama-v*` publishes `@namzu/ollama`, `http-v*` publishes `@namzu/http`, and so on. Publishing to npm is handled via **Trusted Publisher (OIDC)**: no long-lived `NPM_TOKEN` secret lives in the repo, and every release ships with `--provenance`.

Locally, each package provides `pnpm release:<channel>` scripts (`rc`, `patch`, `minor`, `major`, `stable`, `beta`, `alpha`) that bump `package.json`, commit, tag, and push. The workflow picks up the tag and publishes under the correct dist-tag (`*-rc.*` → `rc`, plain semver → `latest`, etc.). Never hand-edit `package.json` versions; the tag is the canonical release signal. See `AGENTS.md` section **Release Flow** for the full contract, and `packages/providers/PUBLISH_CHECKLIST.md` for the first-release bootstrap runbook.

## Project Status and Roadmap

Namzu is in its **pre-1.0 phase** and moving fast.

- **Published.** `@namzu/sdk@0.1.6` on npm — full agent runtime, persona system, tool definitions, streaming. `@namzu/computer-use@0.1.0` ships alongside as the first opt-in capability package.
- **In flight.** Per-vendor provider extraction per [ADR-0001](docs/architecture/decisions/0001-per-vendor-provider-extraction.md). `@namzu/bedrock`, `@namzu/openrouter`, `@namzu/ollama`, `@namzu/lmstudio`, `@namzu/openai`, `@namzu/anthropic`, and `@namzu/http` are implemented, tested, and committed — they land as a coordinated batch release alongside `@namzu/sdk@1.0.0`, which introduces the `ProviderRegistry` pattern. `@namzu/sdk@0.1.x` continues to receive critical security backports until **2026-10-15**.
- **Next.** `@namzu/telemetry` — opt-in OpenTelemetry instrumentation for agents, tools, and LLM calls. OTel was stripped from provider `v0.1.0` specifically so the telemetry package owns that surface cleanly.
- **Planned.** Additional protocol bridges (e.g. a `gemini` dialect for `@namzu/http`), community-contributed provider packages under `@namzu-community/<vendor>`, and publication of the currently-local `@namzu/contracts`, `@namzu/agents`, `@namzu/api`, and `@namzu/cli` once their public APIs stabilize.

No timeline commitments on pre-1.0 work — breaking changes are possible until `@namzu/sdk@1.0.0` ships.

## Documentation

- **ADRs — `docs/architecture/decisions/`.** Decision records for cross-cutting architectural choices. Currently [`0001-per-vendor-provider-extraction.md`](docs/architecture/decisions/0001-per-vendor-provider-extraction.md), the authoritative reference for the provider split, `ProviderRegistry`, `@namzu/http` dialect model, and the `sdk@0.1.x` support window.
- **`docs.local/CONVENTIONS.md`.** Lean one-paragraph-per-rule code conventions (naming, error handling, barrels, provider abstraction, atomic writes, logging, commits). Local-only; not published.
- **`AGENTS.md` and `CLAUDE.md`.** Guidance for AI tools (Claude Code, Codex, etc.) operating inside the repo — doc hierarchy, working flow, dependency direction, release flow, git safety rules, commit conventions.
- **Per-package `README.md`.** Each published package documents its own install, auth, configuration, and usage.

## Contributing

Contributions are welcome on the publicly tracked packages (`@namzu/sdk`, `@namzu/computer-use`, and provider packages under `packages/providers/`).

- **Bugs and feature requests.** Open a GitHub issue on `cogitave/namzu` with a reproducible case or a clear use-case motivation. Prefer discussion on an issue before a large PR.
- **Pull requests.** Follow `packages/sdk/CONTRIBUTING.md`. Keep PRs narrowly scoped. Run `pnpm typecheck && pnpm lint && pnpm test` locally before pushing; CI enforces all three. New conventions go through an ADR.
- **Commit style.** Conventional Commits are **required**. Example: `feat(sdk): add ProviderRegistry.listTypes`. Breaking changes use `!` (`feat(sdk)!: ...`) with a `BREAKING CHANGE:` footer.
- **No AI co-author trailers.** Commits must not include `Co-Authored-By: Claude …` or similar.

Community provider packages are encouraged under the `@namzu-community/<vendor>` scope — open an issue if you'd like one linked from the README.

## License

Namzu is released under the **Functional Source License, Version 1.1, MIT Future License (FSL-1.1-MIT)**. The license grants production and non-commercial use immediately with a narrow competing-use restriction, and automatically converts to MIT two years after each release. Full text: [LICENSE.md](LICENSE.md).

## Acknowledgements

Namzu draws on lessons from prior work in the ecosystem: the Vercel AI SDK demonstrated that a per-provider package split produces a cleaner install footprint than a monolithic core; LangChain mapped out the problem shape of agent frameworks and toolchains; and Anthropic's Model Context Protocol (MCP) informed how we think about tool and capability boundaries. Namzu's choices differ in places — most visibly in the registry-plus-explicit-activation pattern over side-effect auto-registration — but the intellectual debt is real and worth naming.
