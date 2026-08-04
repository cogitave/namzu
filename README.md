<!-- okf
type: Index
title: Namzu
description: >-
  An agent kernel for TypeScript — OS-level sandboxes, lifecycle, scheduling,
  budgets, signals, memory, durability, MCP/A2A, provider abstraction. No UI,
  no hosted service, no vendor favorites. FSL-1.1-MIT (converts to MIT after
  two years per release).
tags: [readme, index, typescript, agent-kernel]
timestamp: 2026-07-09T00:00:00Z
status: active
diataxis: explanation
-->
<div align="center">

<h1>Namzu</h1>

**The agent kernel for TypeScript. Nothing between you and your agents.**

[![License: FSL-1.1-MIT](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](./LICENSE.md)
[![npm @namzu/sdk](https://img.shields.io/npm/v/@namzu/sdk.svg?label=%40namzu%2Fsdk)](https://www.npmjs.com/package/@namzu/sdk)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![TypeScript 5.5+](https://img.shields.io/badge/typescript-5.5%2B-3178c6.svg)](https://www.typescriptlang.org)

[Quick Start](#quick-start) · [What Namzu Is](#what-namzu-is) · [npm](https://www.npmjs.com/package/@namzu/sdk) · [Docs](./docs/) · [Contributing](#contributing)

<sub>Fair Source licensing: [FSL-1.1-MIT](./LICENSE.md) — every published version converts to MIT two years after its release.</sub>

</div>

---

## The Thesis

Most "agent frameworks" today are application frameworks. They bundle chat UIs, hosted dashboards, vendor-specific fast paths, and integration drivers for a handful of databases. You get a demo in an hour; three months later you own a stack where the framework dictates your frontend, your database, your observability, and your model vendor.

Agent software should be layered like Unix. At the bottom: a **kernel** that isolates processes, schedules tool calls, manages memory pressure, propagates signals across a call tree, persists checkpoints, mediates inter-process communication, and produces an auditable event stream. Above the kernel: user space — shells, editors, IDEs, voice gateways, React apps. The kernel does not care which shell you pick; the shell cannot break the isolation the kernel provides.

**`@namzu/sdk` is the kernel.** It runs agents the way Unix runs processes. It does not render UI, it does not pick your database, it does not favor one LLM vendor. `packages/providers/*` are the drivers — one per vendor, each pulled in only when you need it. This repo is the whole family under one roof.

---

## What Namzu Is

- **Process execution and isolation.** Tools run inside OS-level sandboxes: Seatbelt (SBPL) on macOS, mount + PID namespaces on Linux. Deny-default file I/O, scoped network, enforced resource limits. No Docker, no daemon, no sidecar in the kernel — and the opt-in [`@namzu/sandbox`](https://www.npmjs.com/package/@namzu/sandbox) package adds pluggable providers: process-level isolation (bubblewrap/Seatbelt via `@anthropic-ai/sandbox-runtime`) for dev loops, container-level isolation with a JWT-authenticated egress proxy for multi-tenant deployments.
- **Agent lifecycle.** Parent/child spawn with depth tracking, budget splitting, causal trace linkage. A supervisor forks a subtree and gets results back, each child isolated from its siblings.
- **Scheduling.** Per-run token, cost, wall-clock, and iteration budgets. Task router (cheap model for compaction, expensive for coding), tool tiering, limit checker.
- **Signals.** `AbortController` tree spanning parent and children. `cancel(taskId)` and `cancelAll(parentRunId)` propagate. Runs pause, resume, and abort cleanly.
- **Memory.** Working memory via structured compaction into a typed `WorkingState`. Long-term memory via an indexed, tag/query/status-searchable store with disk persistence. No vector database required by default.
- **Durability.** Atomic per-iteration checkpoints, opt-in emergency core-dump on SIGINT/SIGTERM, separate stores for runs / threads / conversations / activities / memories / tasks.
- **IPC.** Native A2A (Google agent-to-agent) and MCP (Anthropic Model Context Protocol) — both client and server, one SDK. An internal event bus with circuit breakers, file lock manager, and edit ownership tracking.
- **Provider abstraction.** A narrow `LLMProvider` interface + a typed `ProviderRegistry`. Concrete vendors live in sibling packages (`@namzu/anthropic`, `@namzu/openai`, `@namzu/bedrock`, `@namzu/openrouter`, `@namzu/ollama`, `@namzu/lmstudio`, `@namzu/http`). BYOK everywhere, no hidden hot paths.
- **Multi-tenant isolation from day one.** Connector registries, vaults, configs, and stores are tenant-scoped. Two organizations share a process without cross-contamination.
- **Telemetry.** OpenTelemetry-native spans and metrics against the `@opentelemetry/api` peer; the OTLP exporter pipeline (traces + metrics, resource attributes, platform metrics) ships as the opt-in [`@namzu/telemetry`](https://www.npmjs.com/package/@namzu/telemetry) package. Cost accounting (input tokens, output tokens, cached tokens, cache write tokens) flows from the provider into per-run, per-tenant rollups.

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

| Package               | Purpose                                                                  | Version |
|-----------------------|--------------------------------------------------------------------------|---------|
| `@namzu/sdk`          | The kernel — runtime, agents, tools, registry, stores, RAG, connectors   | [![npm](https://img.shields.io/npm/v/@namzu/sdk.svg?label=)](https://www.npmjs.com/package/@namzu/sdk) |
| `@namzu/computer-use` | Subprocess-based `ComputerUseHost` (screenshot, mouse, keyboard)         | [![npm](https://img.shields.io/npm/v/@namzu/computer-use.svg?label=)](https://www.npmjs.com/package/@namzu/computer-use) |
| `@namzu/sandbox`      | Pluggable sandbox providers — process-level (bubblewrap/Seatbelt) and container-level (JWT-authenticated egress proxy) isolation | [![npm](https://img.shields.io/npm/v/@namzu/sandbox.svg?label=)](https://www.npmjs.com/package/@namzu/sandbox) |
| `@namzu/telemetry`    | OTLP exporter pipeline — traces + metrics, resource attributes, platform metrics | [![npm](https://img.shields.io/npm/v/@namzu/telemetry.svg?label=)](https://www.npmjs.com/package/@namzu/telemetry) |
| `@namzu/cli`          | Operator CLI (`namzu doctor` + future commands) — standalone bin and library | [![npm](https://img.shields.io/npm/v/@namzu/cli.svg?label=)](https://www.npmjs.com/package/@namzu/cli) |
| `@namzu/files`        | Provider-agnostic file registry contracts                                | [![npm](https://img.shields.io/npm/v/@namzu/files.svg?label=)](https://www.npmjs.com/package/@namzu/files) |
| `@namzu/anthropic`    | Anthropic Messages API provider                                          | [![npm](https://img.shields.io/npm/v/@namzu/anthropic.svg?label=)](https://www.npmjs.com/package/@namzu/anthropic) |
| `@namzu/openai`       | OpenAI Chat Completions provider                                         | [![npm](https://img.shields.io/npm/v/@namzu/openai.svg?label=)](https://www.npmjs.com/package/@namzu/openai) |
| `@namzu/bedrock`      | AWS Bedrock Converse provider                                            | [![npm](https://img.shields.io/npm/v/@namzu/bedrock.svg?label=)](https://www.npmjs.com/package/@namzu/bedrock) |
| `@namzu/openrouter`   | OpenRouter aggregated-model provider                                     | [![npm](https://img.shields.io/npm/v/@namzu/openrouter.svg?label=)](https://www.npmjs.com/package/@namzu/openrouter) |
| `@namzu/ollama`       | Local Ollama provider                                                    | [![npm](https://img.shields.io/npm/v/@namzu/ollama.svg?label=)](https://www.npmjs.com/package/@namzu/ollama) |
| `@namzu/lmstudio`     | LM Studio local-inference provider (WebSocket)                           | [![npm](https://img.shields.io/npm/v/@namzu/lmstudio.svg?label=)](https://www.npmjs.com/package/@namzu/lmstudio) |
| `@namzu/http`         | Zero-dep generic HTTP provider (OpenAI- or Anthropic-compatible)         | [![npm](https://img.shields.io/npm/v/@namzu/http.svg?label=)](https://www.npmjs.com/package/@namzu/http) |

<sub>Version cells are live badges from the npm registry, so the table cannot go stale.</sub>

All thirteen packages are on npm, each release carrying npm provenance
attestation (see [Release Flow](#release-flow)). `@namzu/cli` (0.2.x) and
`@namzu/files` (0.1.x) are published early and still pre-1.0; everything else
is at or past 1.0.

## Quick Start

Install the kernel plus one provider — Ollama is the zero-config local-first default:

```bash
pnpm add @namzu/sdk @namzu/ollama
```

```typescript
import { ProviderRegistry, runAgent } from '@namzu/sdk'
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

const { output } = await runAgent({
  provider,
  model: 'llama3.2',
  prompt: 'What is the capital of France?',
})

console.log(output)
```

That is an agent run, not a chat call: the loop, the tool scheduler, budget
enforcement, checkpointing and the event stream are all in it. `runAgent`
supplies the parts a single-tenant local run has no opinion about — it
generates the session identity, defaults the budgets, and points the working
directory at the process's own — and hands the identity back on the result so
the next turn continues the same session:

```typescript
const first = await runAgent({ provider, model, prompt: 'My name is Ada.' })

const second = await runAgent({
  provider,
  model,
  ...first.identity,
  prompt: [...first.run.messages, createUserMessage('What is my name?')],
})
```

Give it `tools` and the same call runs a tool loop. When you outgrow the
defaults — a real tenant, your own budgets, human-in-the-loop review,
compaction policy — every option is a `drainQuery` parameter and you drop down
to `drainQuery` itself without changing engines.

The kernel installed alone runs against `MockLLMProvider` — pre-registered, no
network dependencies, and scriptable: give it `turns` and it emits tool calls
with the same stream framing a real driver produces.

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
│   ├── sdk/                       @namzu/sdk            the kernel
│   ├── computer-use/              @namzu/computer-use   capability: desktop control
│   ├── sandbox/                   @namzu/sandbox        capability: isolation providers
│   ├── telemetry/                 @namzu/telemetry      capability: OTLP exporter pipeline
│   ├── cli/                       @namzu/cli            user space: operator CLI
│   ├── files/                     @namzu/files          contracts: file registry
│   └── providers/                 the seven vendor drivers
│       ├── anthropic/  bedrock/  http/  lmstudio/
│       ├── ollama/  openai/  openrouter/
│       └── PUBLISH_CHECKLIST.md
├── docs/                          docs-site source: getting-started, per-package guides, migration
├── .github/workflows/             ci.yml · release.yml (Changesets) · sandbox-smoke.yml
├── AGENTS.md  CLAUDE.md           AI-tool guidance
└── LICENSE.md
```

Four further packages — `contracts`, `agents`, `api`, `docs` — plus the
detailed pattern docs in `docs.local/` exist only on the maintainer's machine
(gitignored); they land on npm once their public APIs stabilise.

## Architecture

`@namzu/sdk` is the core and has no workspace dependencies. Provider and capability packages depend on the SDK via a `peerDependencies` entry on `@namzu/sdk`; nothing in the SDK depends back on them.

```
                ┌────────────────────────────────────────┐
                │               @namzu/sdk               │
                │                                        │
                │  • LLMProvider interface               │
                │  • ProviderRegistry (register/create)  │
                │  • MockLLMProvider (pre-registered)    │
                │  • runtime, agents, tools, personas    │
                │  • sandbox, vault, plugins, RAG        │
                └────────────────────────────────────────┘
                       ▲                        ▲
        peerDependency │         peerDependency │
                       │                        │
      ┌────────────────┴──┐        ┌────────────┴──────────┐
      │ Provider packages │        │  Capability packages  │
      │                   │        │                       │
      │  @namzu/anthropic │        │  @namzu/computer-use  │
      │  @namzu/openai    │        │  @namzu/sandbox       │
      │  @namzu/bedrock   │        │  @namzu/telemetry     │
      │  @namzu/openrouter│        │                       │
      │  @namzu/ollama    │        │                       │
      │  @namzu/lmstudio  │        │                       │
      │  @namzu/http      │        │                       │
      └───────────────────┘        └───────────────────────┘
```

Above the kernel sits user space: `@namzu/cli` — the operator CLI — consumes
the SDK and providers as normal dependencies, exactly the layering the thesis
prescribes. Beside the tree, `@namzu/files` is a standalone contracts package
(no SDK dependency).

Concrete contract points (verified in source and on npm):

- `@namzu/sdk` exports the `LLMProvider` interface (`src/types/provider/`) and `ProviderRegistry` + `UnknownProviderError` / `DuplicateProviderError` (`src/provider/`). Both are re-exported from the root barrel.
- Each published provider package declares `"@namzu/sdk": ">=1.0.0"` under `peerDependencies` and exports a `register<Vendor>()` function calling `ProviderRegistry.register(type, Class, capabilities, options)`. Providers use `declare module '@namzu/sdk'` to extend `ProviderConfigRegistry` so `ProviderRegistry.create({ type, ... })` narrows to the correct config type.
- The capability packages follow the same discipline: `@namzu/computer-use`, `@namzu/sandbox`, and `@namzu/telemetry` each peer-declare `"@namzu/sdk": ">=1.0.0"`.
- `@namzu/computer-use` is a capability package: a subprocess-based `ComputerUseHost` for the contract in `@namzu/sdk` (platform-native CLIs — `screencapture`/`osascript` on darwin, `xdotool`/`maim` on X11, `grim`/`wtype`/`ydotool` on Wayland, PowerShell on Windows).
- Dependency direction is strictly downward: `@namzu/sdk` does not import any `@namzu/*` workspace package.

**Note on SDK footprint.** npm lists no bundled `dependencies` for the published `@namzu/sdk@1.3.0` — its runtime needs are **peer-declared** (`zod` ^3.23.0, `zod-to-json-schema` ^3.23.0, `@opentelemetry/api` ^1.9.0), so your lockfile owns the versions. This is the per-vendor extraction boundary applied: vendor SDKs live in the provider packages, and the heavier OTLP exporter stack ships separately as `@namzu/telemetry`.

## Design Principles

Five choices shape every decision in this repo.

- **No workarounds. Fix at the root.** When something is wrong, fix the pattern, not the symptom.
- **Type safety is the foundation.** Every resource ID is branded (`RunId`, `ThreadId`, `TaskId`, `TenantId`, `AgentId`, `ToolId`, `MemoryId`, ...). Every discriminated union has exhaustiveness checks. Every public API has Zod-validated inputs at the boundary. The compiler is the first line of defense.
- **Deny by default. Fail fast.** Sandboxes deny file I/O by default. Verification gates deny tool calls by default unless a rule allows them. Limit checkers fail the run the moment a budget is breached. Configuration errors throw at boot.
- **Dependency direction is sacred.** `@namzu/sdk` knows nothing about providers, capabilities, or apps. Circular dependencies are a compile error, not a review suggestion.
- **Convention over surprise.** Every new feature follows a shared pattern language — Registries, Managers, Stores, Runs, Bridges, Providers. Read one subsystem, navigate the next.

## Release Flow

Releases are driven by [Changesets](https://github.com/changesets/changesets):
each PR carries its changeset, and merging to `main` triggers
[`release.yml`](.github/workflows/release.yml), which runs the full validation
gate (lint, typecheck, build, test, publint), versions the packages, publishes
with npm provenance enabled (`NPM_CONFIG_PROVENANCE=true`), and cuts the
matching GitHub releases. Every published version carries a verifiable SLSA
build attestation linking the tarball to this repository and workflow — check
the "Provenance" panel on any package's npm page. `ci.yml` is the per-push
gate, and `sandbox-smoke.yml` additionally smoke-tests the sandbox provider.

## Project Status

- **Thirteen packages are on npm** — the kernel at 1.3.x; `@namzu/computer-use`, `@namzu/sandbox`, `@namzu/telemetry`, and all seven providers at or past 1.0; `@namzu/cli` (0.2.x) and `@namzu/files` (0.1.x) published early, APIs still moving. `ProviderRegistry` is the current API; the older `ProviderFactory` is no longer exported. `MockLLMProvider` is pre-registered under `'mock'`.
- **Four packages local-only** — `contracts`, `agents`, `api`, `docs` are gitignored, not part of the public release surface today.

Roadmap direction:

- Take `@namzu/cli` and `@namzu/files` to a stable 1.0.
- Eventual publication of the currently-local packages as they stabilise.

## The Cogitave family

Namzu stands alone — it needs nothing from its siblings. It is also part of one
product family, stated at its honest level:

| Repo | Role | Honest relationship |
|---|---|---|
| **Namzu** (here) | the **agent kernel for TypeScript** — runs agents the way Unix runs processes | independent; usable today via npm |
| [**Yuva**](https://github.com/cogitave/yuva) | the **home** — a from-scratch, agent-native sovereign OS / micro-VMM where the boot is the proof | a *literal* kernel that boots; Namzu is a kernel by analogy (a TypeScript runtime) — same word, two layers |
| [**Cogi**](https://github.com/cogitave/cogi) *(private until the operator cut)* | the **mind** — Yuva's resident agent | Namzu is Cogi's *planned* action/skills layer — **deferred; no bridge exists today** |

"What Namzu Is Not" above is the same discipline Yuva enforces at boot with
machine-emitted honesty tokens — applied here to scope, in prose.

## Documentation

- **[`packages/sdk/README.md`](./packages/sdk/README.md)** — the kernel's complete subsystem map. If you want to know what Namzu does, this is the single best document.
- **[`docs/`](./docs/)** — the documentation-site source: [`getting-started.md`](./docs/getting-started.md), per-package guides (`sdk/`, `providers/`, `cli/`, `computer-use/`), and `migration/` notes.
- **`AGENTS.md` / `CLAUDE.md`** — canonical guidance for any AI coding tool operating inside the repo.
- **`docs.local/`** — detailed pattern docs and conventions. Local-only.
- **Per-package READMEs** — every package documents its own install, auth, and usage.

## Contributing

Issues and PRs welcome at [cogitave/namzu](https://github.com/cogitave/namzu). See [`packages/sdk/CONTRIBUTING.md`](./packages/sdk/CONTRIBUTING.md) for local setup and conventions.

## License

[FSL-1.1-MIT](./LICENSE.md) — Fair Source. The Functional Source License converts to MIT two years after each release, so every published version of Namzu becomes MIT-licensed on its second anniversary.
