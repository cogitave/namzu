<div align="center">

<h1>Namzu</h1>

**An open-source agent kernel for TypeScript. Nothing between you and your agents.**

[![License: FSL-1.1-MIT](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](./LICENSE.md)
[![npm @namzu/sdk](https://img.shields.io/npm/v/@namzu/sdk.svg?label=%40namzu%2Fsdk)](https://www.npmjs.com/package/@namzu/sdk)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![TypeScript 5.5+](https://img.shields.io/badge/typescript-5.5%2B-3178c6.svg)](https://www.typescriptlang.org)

</div>

---

## The Thesis

Most "agent frameworks" today are application frameworks. They bundle chat UIs, hosted dashboards, vendor-specific fast paths, and integration drivers for a handful of databases. You get a demo in an hour; three months later you own a stack where the framework dictates your frontend, your database, your observability, and your model vendor.

Agent software should be layered like Unix. At the bottom: a **kernel** that isolates processes, schedules tool calls, manages memory pressure, propagates signals across a call tree, persists checkpoints, mediates inter-process communication, and produces an auditable event stream. Above the kernel: user space — shells, editors, IDEs, voice gateways, React apps. The kernel does not care which shell you pick; the shell cannot break the isolation the kernel provides.

**`@namzu/sdk` is the kernel.** It runs agents the way Unix runs processes. It does not render UI, it does not pick your database, it does not favor one LLM vendor. `packages/providers/*` are the drivers — one per vendor, each pulled in only when you need it. This repo is the whole family under one roof.

---

## What Namzu Is

- **Process execution and isolation.** Tools run inside OS-level sandboxes: Seatbelt (SBPL) on macOS, mount + PID namespaces on Linux. Deny-default file I/O, scoped network, enforced resource limits. No Docker, no daemon, no sidecar.
- **Agent lifecycle.** Parent/child spawn with depth tracking, budget splitting, causal trace linkage. A supervisor forks a subtree and gets results back, each child isolated from its siblings.
- **Scheduling.** Per-run token, cost, wall-clock, and iteration budgets. Task router (cheap model for compaction, expensive for coding), tool tiering, limit checker.
- **Signals.** `AbortController` tree spanning parent and children. `cancel(taskId)` and `cancelAll(parentRunId)` propagate. Runs pause, resume, and abort cleanly.
- **Memory.** Working memory via structured compaction into a typed `WorkingState`. Long-term memory via an indexed, tag/query/status-searchable store with disk persistence. No vector database required by default.
- **Durability.** Atomic per-iteration checkpoints, automatic emergency core-dump on SIGINT/SIGTERM, separate stores for runs / threads / conversations / activities / memories / tasks.
- **IPC.** Native A2A (Google agent-to-agent) and MCP (Anthropic Model Context Protocol) — both client and server, one SDK. An internal event bus with circuit breakers, file lock manager, and edit ownership tracking.
- **Provider abstraction.** A narrow `LLMProvider` interface + a typed `ProviderRegistry`. Concrete vendors live in sibling packages (`@namzu/anthropic`, `@namzu/openai`, `@namzu/bedrock`, `@namzu/openrouter`, `@namzu/ollama`, `@namzu/lmstudio`, `@namzu/http`). BYOK everywhere, no hidden hot paths.
- **Multi-tenant isolation from day one.** Connector registries, vaults, configs, and stores are tenant-scoped. Two organizations share a process without cross-contamination.
- **Telemetry.** OpenTelemetry-native spans and metrics. Cost accounting (input tokens, output tokens, cached tokens, cache write tokens) flows from the provider into per-run, per-tenant rollups.

See [`packages/sdk/README.md`](./packages/sdk/README.md) for the complete subsystem map — 24 sections covering sandbox, bus, lifecycle, scheduling, runtime, memory, durability, HITL, personas, skills, advisory, connectors, prompt cache, vault, telemetry, plugins, gateway, agent patterns, and multi-tenancy.

## What Namzu Is Not

- **Not a chat SDK.** No React/Svelte/Vue hooks, no generative UI components, no `useChat`. Your UI framework is your choice; the kernel hands you a typed event stream.
- **Not a hosted service.** No dashboard, no Namzu Cloud, no billing page. You run it in your own process.
- **Not a deployment adapter.** No Next.js / Hono / Express / Cloudflare Workers plumbing in the kernel. Those belong in separate packages or your own infra.
- **Not a dev studio.** No bundled playground UI.
- **Not a vector database.** RAG ships with a pluggable `VectorStore` interface; the kernel does not embed pgvector or Pinecone.
- **Not an LLM router service.** Task routing is an in-process policy.
- **Not a prompt management UI.** Personas are YAML files in your repo, not database rows behind a web form.

The goal is not to be minimal — the kernel is plenty rich. The goal is to keep its **interface surface** small and stable so the layers above can move fast without breaking what is underneath.

---

## Monorepo at a Glance

| Package                   | Purpose                                                              | Version         | Status        |
|---------------------------|----------------------------------------------------------------------|-----------------|---------------|
| `@namzu/sdk`              | The kernel — runtime, agents, tools, registry, stores, RAG, connectors | `0.1.7`         | published     |
| `@namzu/computer-use`     | Subprocess-based `ComputerUseHost` (screenshot, mouse, keyboard)     | `0.1.0`         | published     |
| `@namzu/anthropic`        | Anthropic Messages API provider                                      | `0.1.0`         | published   |
| `@namzu/openai`           | OpenAI Chat Completions provider                                     | `0.1.0`         | published   |
| `@namzu/bedrock`          | AWS Bedrock Converse provider                                        | `0.1.0`         | published   |
| `@namzu/openrouter`       | OpenRouter aggregated-model provider                                 | `0.1.0`         | published   |
| `@namzu/ollama`           | Local Ollama provider                                                | `0.1.0`         | published   |
| `@namzu/lmstudio`         | LM Studio local-inference provider (WebSocket)                       | `0.1.0`         | published   |
| `@namzu/http`             | Zero-dep generic HTTP provider (OpenAI- or Anthropic-compatible)     | `0.1.0`         | published   |

Unpublished packages are tracked, tested, and committed in the repo; first npm publication is the next batched step (see `packages/providers/PUBLISH_CHECKLIST.md`).

## Quick Start

Install the kernel plus one provider — Ollama is the zero-config local-first default:

```bash
pnpm add @namzu/sdk @namzu/ollama
```

```typescript
import { ProviderRegistry, createUserMessage } from '@namzu/sdk'
import { registerOllama } from '@namzu/ollama'

// Register once at startup. Swap this line for another vendor:
//   import { registerOpenAI }   from '@namzu/openai'   ; registerOpenAI()
//   import { registerAnthropic } from '@namzu/anthropic'; registerAnthropic()
//   import { registerBedrock }  from '@namzu/bedrock'  ; registerBedrock()
// Everything below the registration line stays identical.
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

The response is `{ id, model, message: { role, content, toolCalls? }, finishReason, usage }`. The kernel installed alone runs against `MockLLMProvider` — pre-registered, no network dependencies, good for tests.

## Provider Selection

Every provider implements the same `LLMProvider` contract; agent code is portable across all of them.

| Backend    | Install                                 | Key config fields                                                          |
|------------|-----------------------------------------|----------------------------------------------------------------------------|
| OpenAI     | `pnpm add @namzu/sdk @namzu/openai`     | `apiKey`, `model?`, `baseURL?`, `organization?`, `project?`                |
| Anthropic  | `pnpm add @namzu/sdk @namzu/anthropic`  | `apiKey`, `model?`, `baseURL?`, `maxTokens?`                               |
| Bedrock    | `pnpm add @namzu/sdk @namzu/bedrock`    | `region?`, `accessKeyId?`, `secretAccessKey?`, `sessionToken?`             |
| OpenRouter | `pnpm add @namzu/sdk @namzu/openrouter` | `apiKey`, `baseUrl?`, `siteUrl?`, `siteName?`                              |
| Ollama     | `pnpm add @namzu/sdk @namzu/ollama`     | `host?`, `model?`, `fetch?`, `timeout?`                                    |
| LM Studio  | `pnpm add @namzu/sdk @namzu/lmstudio`   | `host?`, `model?`, `timeout?`                                              |
| HTTP       | `pnpm add @namzu/sdk @namzu/http`       | `baseURL`, `apiKey?`, `dialect?` (`'openai'` \| `'anthropic'`), `headers?` |
| Mock       | `pnpm add @namzu/sdk` (built-in)        | `model?`, `responseText?`, `responseDelayMs?`                              |

Each provider package exports a `register<Vendor>()` helper and uses TypeScript module augmentation to extend `ProviderConfigRegistry` — so `ProviderRegistry.create({ type: 'openai', apiKey: ... })` is fully type-narrowed.

## Repository Layout

```
namzu/
├── packages/
│   ├── sdk/                       @namzu/sdk           0.1.7   published
│   ├── computer-use/              @namzu/computer-use  0.1.0   published
│   ├── providers/
│   │   ├── anthropic/             @namzu/anthropic     0.1.0   published
│   │   ├── bedrock/               @namzu/bedrock       0.1.0   published
│   │   ├── http/                  @namzu/http          0.1.0   published
│   │   ├── lmstudio/              @namzu/lmstudio      0.1.0   published
│   │   ├── ollama/                @namzu/ollama        0.1.0   published
│   │   ├── openai/                @namzu/openai        0.1.0   published
│   │   ├── openrouter/            @namzu/openrouter    0.1.0   published
│   │   └── PUBLISH_CHECKLIST.md
│   ├── contracts/                                              local-only (gitignored)
│   ├── agents/                                                 local-only (gitignored)
│   ├── api/                                                    local-only (gitignored)
│   ├── cli/                                                    local-only (gitignored)
│   └── docs/                                                   local-only (gitignored)
├── docs/architecture/decisions/   public ADRs
├── docs.local/                    detailed pattern + convention docs (gitignored)
├── .github/workflows/             per-package release-*.yml + ci.yml
├── AGENTS.md  CLAUDE.md           AI-tool guidance
└── LICENSE.md
```

The five local-only packages (`contracts`, `agents`, `api`, `cli`, `docs`) exist on the maintainer's machine and are gitignored; they land on npm once their public APIs stabilise.

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
                │  • sandbox, vault, plugins, RAG        │
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

- `@namzu/sdk` exports the `LLMProvider` interface (`src/types/provider/`) and `ProviderRegistry` + `UnknownProviderError` / `DuplicateProviderError` (`src/provider/`). Both are re-exported from the root barrel.
- Each provider package declares `"@namzu/sdk": "^1 || ^0.1.6"` under `peerDependencies` and exports a `register<Vendor>()` function calling `ProviderRegistry.register(type, Class, capabilities, options)`. Providers use `declare module '@namzu/sdk'` to extend `ProviderConfigRegistry` so `ProviderRegistry.create({ type, ... })` narrows to the correct config type.
- `@namzu/computer-use` is a capability package: a subprocess-based `ComputerUseHost` for the contract in `@namzu/sdk` (platform-native CLIs — `screencapture`/`osascript` on darwin, `xdotool`/`maim` on X11, `grim`/`wtype`/`ydotool` on Wayland, PowerShell on Windows).
- Dependency direction is strictly downward: `@namzu/sdk` does not import any `@namzu/*` workspace package.

**Note on SDK footprint.** Published `@namzu/sdk@0.1.7` still carries `zod`, `zod-to-json-schema`, and eight `@opentelemetry/*` runtime dependencies. ADR-0001 describes a leaner target for the provider-extraction boundary; that reduction is planned, not yet applied.

## Design Principles

Five choices shape every decision in this repo.

- **No workarounds. Fix at the root.** When something is wrong, fix the pattern, not the symptom.
- **Type safety is the foundation.** Every resource ID is branded (`RunId`, `ThreadId`, `TaskId`, `TenantId`, `AgentId`, `ToolId`, `MemoryId`, ...). Every discriminated union has exhaustiveness checks. Every public API has Zod-validated inputs at the boundary. The compiler is the first line of defense.
- **Deny by default. Fail fast.** Sandboxes deny file I/O by default. Verification gates deny tool calls by default unless a rule allows them. Limit checkers fail the run the moment a budget is breached. Configuration errors throw at boot.
- **Dependency direction is sacred.** `@namzu/sdk` knows nothing about providers, capabilities, or apps. Circular dependencies are a compile error, not a review suggestion.
- **Convention over surprise.** Every new feature follows a shared pattern language — Registries, Managers, Stores, Runs, Bridges, Providers. Read one subsystem, navigate the next.

## Release Flow

Every published package has its own release workflow in `.github/workflows/`, keyed off a tag prefix:

| Tag prefix        | Workflow                       | Publishes             |
|-------------------|--------------------------------|-----------------------|
| `sdk-v*`          | `release-sdk.yml`              | `@namzu/sdk`          |
| `computer-use-v*` | `release-computer-use.yml`     | `@namzu/computer-use` |
| `anthropic-v*`    | `release-anthropic.yml`        | `@namzu/anthropic`    |
| `bedrock-v*`      | `release-bedrock.yml`          | `@namzu/bedrock`      |
| `http-v*`         | `release-http.yml`             | `@namzu/http`         |
| `lmstudio-v*`     | `release-lmstudio.yml`         | `@namzu/lmstudio`     |
| `ollama-v*`       | `release-ollama.yml`           | `@namzu/ollama`       |
| `openai-v*`       | `release-openai.yml`           | `@namzu/openai`       |
| `openrouter-v*`   | `release-openrouter.yml`       | `@namzu/openrouter`   |

Publishing uses npm Trusted Publisher (OIDC) with `--provenance`. No `NPM_TOKEN` in the repo. Locally, release is driven by `pnpm release:<channel>` (`patch`, `minor`, `major`, `rc`, `beta`, `stable`, `dry`) inside each package — the script bumps the version, commits, tags, and pushes; the GitHub Action picks up the tag and publishes. First-time provider publication follows `packages/providers/PUBLISH_CHECKLIST.md`.

## Project Status

- **`@namzu/sdk@0.1.7`** — latest on npm. `ProviderRegistry` is the current API; the older `ProviderFactory` is no longer exported. `MockLLMProvider` is pre-registered under `'mock'`.
- **`@namzu/computer-use@0.1.0`** — published.
- **Seven provider packages at `0.1.0`** — implemented, tested, committed; **not yet on npm**. Batched publication is the next step.
- **Five packages local-only** — gitignored, not part of the public release surface today.

Roadmap direction (see [ADR-0001](docs/architecture/decisions/0001-per-vendor-provider-extraction.md) for the vendor-split rationale):

- A `1.0.0` boundary for `@namzu/sdk` is discussed in ADR-0001 alongside the provider peer-range strategy (`"@namzu/sdk": "^1 || ^0.1.6"`). No date committed.
- A future `@namzu/telemetry` package to host OpenTelemetry instrumentation as an opt-in dependency.
- Eventual publication of currently-local packages as they stabilise.

## Documentation

- **[`packages/sdk/README.md`](./packages/sdk/README.md)** — the kernel's complete subsystem map. If you want to know what Namzu does, this is the single best document.
- **`docs/architecture/decisions/`** — public ADRs. Today: [`0001-per-vendor-provider-extraction.md`](docs/architecture/decisions/0001-per-vendor-provider-extraction.md).
- **`AGENTS.md` / `CLAUDE.md`** — canonical guidance for AI tools (Claude, Codex, Cursor) operating inside the repo.
- **`docs.local/`** — detailed pattern docs and conventions. Local-only.
- **Per-package READMEs** — every package documents its own install, auth, and usage.

## Contributing

Issues and PRs welcome at [cogitave/namzu](https://github.com/cogitave/namzu). See [`packages/sdk/CONTRIBUTING.md`](./packages/sdk/CONTRIBUTING.md) for local setup and conventions.

## License

[FSL-1.1-MIT](./LICENSE.md). The Functional Source License converts to MIT two years after each release, so every published version of Namzu becomes MIT-licensed on its second anniversary.
