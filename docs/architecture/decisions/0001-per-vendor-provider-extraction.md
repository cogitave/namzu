---
title: Per-Vendor Provider Extraction
description: Split LLM providers out of @namzu/sdk into individual npm packages, one per vendor, with a generic @namzu/http fallback for zero-dep users
date: 2026-04-15
status: accepted
related_packages: ["@namzu/sdk", "@namzu/bedrock", "@namzu/openrouter", "@namzu/ollama", "@namzu/lmstudio", "@namzu/openai", "@namzu/anthropic", "@namzu/http"]
---

## Context

`@namzu/sdk@0.1.x` bundles two concrete LLM providers (`BedrockProvider`, `OpenRouterProvider`) directly in core. This forces every consumer — including those who don't use AWS or OpenRouter — to:

1. **Install heavy dependencies** — `@aws-sdk/client-bedrock-runtime` is ~5 MB installed; 9 `@opentelemetry/*` packages sit on top. A consumer who only wants to run `ollama` pulls all of them.
2. **Accept hardcoded coupling** — `ProviderFactory.createProvider()` uses a static `if/else` chain that imports both provider modules unconditionally. Tree-shakers cannot elide them because the factory is the only public entry point.
3. **Wait for us to add vendor support** — users who want OpenAI, Anthropic, Ollama, LM Studio, or Groq today have no path inside the SDK. They must either implement `LLMProvider` themselves or wait.

`ProviderFactory` is already the only coupling point between core and concrete providers. Everything downstream — `runtime`, `agents`, `compaction`, `advisory` — takes a `LLMProvider` instance by interface. So the SDK is architecturally ready for extraction; only the factory is holding it back.

Namzu's positioning — *"Open-source AI agent SDK with a built-in runtime. Nothing between you and your agents."* — is undermined by a bloated core that forces AWS on everyone.

## Decision

Extract every LLM provider into its own npm package under the `@namzu` scope. Core `@namzu/sdk` ships only the `LLMProvider` interface, a new `ProviderRegistry` (replacing `ProviderFactory`), and `MockLLMProvider` (for tests). Each vendor package is independently published, independently versioned, and opt-in.

### Package layout

| Package | Runtime deps | Purpose |
|---------|-------------|---------|
| `@namzu/sdk` | `zod` | Core runtime, `LLMProvider` interface, `ProviderRegistry`, `MockLLMProvider` |
| `@namzu/bedrock` | `@aws-sdk/client-bedrock-runtime` | AWS Bedrock (Converse API) |
| `@namzu/openrouter` | `openai` (OpenAI-compat) | OpenRouter with model routing/fallback features |
| `@namzu/ollama` | `ollama` | Local Ollama server |
| `@namzu/lmstudio` | `@lmstudio/sdk` | LM Studio local server |
| `@namzu/openai` | `openai` | OpenAI Chat Completions API |
| `@namzu/anthropic` | `@anthropic-ai/sdk` | Anthropic Messages API |
| `@namzu/http` | **zero** (fetch only) | Zero-dep generic — any OpenAI- or Anthropic-compatible endpoint via `baseURL` + `dialect` |

### Registry pattern with typed extensibility

`ProviderFactory` (static `if/else` with hardcoded imports) becomes `ProviderRegistry` — a `Map`-backed registry with a **TypeScript interface-merging extension point** so per-vendor packages add their config types without losing discriminated-union narrowing:

```ts
// @namzu/sdk — core
export interface ProviderConfigRegistry {
  mock: MockProviderConfig
}

export type ProviderType = keyof ProviderConfigRegistry
export type ProviderFactoryConfig = ProviderConfigRegistry[ProviderType]

export interface ProviderCapabilities { ... }
export type LLMProviderConstructor<C = unknown> = new (config: C) => LLMProvider

export interface RegisterOptions {
  /** When true, replace an existing registration for this type. Default false → throw on duplicate. */
  replace?: boolean
}

export class ProviderRegistry {
  private static providers = new Map<string, LLMProviderConstructor<unknown>>()
  private static capabilities = new Map<string, ProviderCapabilities>()

  static register<K extends ProviderType>(
    type: K,
    ctor: LLMProviderConstructor<ProviderConfigRegistry[K]>,
    caps: ProviderCapabilities,
    options?: RegisterOptions,
  ): void { ... }

  static create<K extends ProviderType>(
    config: ProviderConfigRegistry[K] & { type: K },
  ): ProviderFactoryResult { ... }

  static isSupported(type: string): type is ProviderType { ... }
  static unregister(type: ProviderType): boolean { ... }
  static listTypes(): ProviderType[] { ... }
}
```

```ts
// @namzu/bedrock — extends the registry via module augmentation
import { ProviderRegistry } from '@namzu/sdk'

declare module '@namzu/sdk' {
  interface ProviderConfigRegistry {
    bedrock: {
      type: 'bedrock'
      region?: string
      accessKeyId?: string
      secretAccessKey?: string
      sessionToken?: string
      timeout?: number
    }
  }
}

export class BedrockProvider implements LLMProvider { ... }

// Explicit registration (users call this once at startup)
export function registerBedrock(opts?: RegisterOptions) {
  ProviderRegistry.register('bedrock', BedrockProvider, BEDROCK_CAPABILITIES, opts)
}
```

```ts
// Consumer
import { ProviderRegistry } from '@namzu/sdk'
import { registerBedrock } from '@namzu/bedrock'

registerBedrock()

// Fully typed: config shape is narrowed to BedrockProviderConfig because type: 'bedrock'
const { provider } = ProviderRegistry.create({
  type: 'bedrock',
  region: 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
})
```

### Registration collision semantics

`register()` **throws `DuplicateProviderError`** by default if a type is already registered. To intentionally replace (e.g. test scenarios, proxy wrappers), callers pass `{ replace: true }`. This prevents last-write-wins footguns in ecosystems where multiple packages could claim the same type string.

### Tree-shake safety — explicit registration, no side-effect imports

**We do not ship side-effect-auto-register entrypoints** (the `@namzu/ollama/auto` pattern). Bundlers (Rollup, esbuild, Vite, Webpack) tree-shake side-effect imports unreliably unless every package declares a correct `sideEffects` array — a contract that drifts across package versions. Instead, each vendor package exports an explicit `register<Vendor>()` function the user calls once at startup. Registration is always intentional and visible in the user's code.

Each vendor package sets `"sideEffects": false` in `package.json` so pure-import tree-shaking is maximal; the `register<Vendor>()` call is the explicit activation point.

`MockLLMProvider` is the one exception: it is **pre-registered** on `@namzu/sdk` import. Its footprint (~50 LoC, zero deps) is negligible; pre-registration means users writing tests need no boilerplate (`ProviderRegistry.create({ type: 'mock' })` works out of the box). `@namzu/sdk`'s `package.json` declares `"sideEffects": ["./dist/provider/mock-register.js"]` to preserve this registration under aggressive tree-shaking.

### Why per-vendor (not per-protocol)

We considered three package-split strategies:

- **Per-protocol** (e.g. `@namzu/http` covers OpenAI + Ollama + LM Studio + Groq + self-hosted OpenAI-compat endpoints via `baseURL`) — minimal packages, maximum reuse.
- **Per-vendor** — each vendor gets a thin wrapper around its official SDK.
- **Hybrid** — popular vendors get dedicated packages, everything else goes through `@namzu/http`.

We chose **hybrid leaning per-vendor**: dedicated packages for the common cases (best DX, uses each vendor's battle-tested official SDK, gets vendor updates automatically) plus `@namzu/http` as a zero-dep escape hatch for users who want no third-party SDK dependency or who target an endpoint not covered by a dedicated package.

Rationale:

- **DX parity with the vendor ecosystem** — a developer familiar with `openai` or `@anthropic-ai/sdk` sees a thin wrapper with no surprises.
- **Less maintenance burden** — official SDKs handle retries, streaming protocol edge cases, and API evolution. We don't reimplement HTTP request/response mapping.
- **Clear signaling** — `pnpm add @namzu/openai` is unambiguous. A user reading the dependency tree immediately sees which vendors the app talks to.
- **Namzu core stays brand-neutral** — the SDK itself doesn't pull AWS or OpenAI as a dep. Installing `@namzu/sdk` alone runs agents against `MockLLMProvider` with no network dependencies at all.

### Why `@namzu/http` exists alongside vendor packages

Every LLM vendor exposes a REST API that can be hit with native `fetch` + `Web Crypto` (Node 20+). `@namzu/http` gives users who want zero runtime dependencies — or who target a niche OpenAI-compat endpoint (vLLM, TGI, llama-server, self-hosted inference) — a first-class alternative:

```ts
import { HttpProvider } from '@namzu/http'

// Any OpenAI-compat endpoint — zero dependencies, pure fetch
const groq = new HttpProvider({
  baseURL: 'https://api.groq.com/openai/v1',
  apiKey: process.env.GROQ_API_KEY,
  dialect: 'openai',
  model: 'llama-3.3-70b-versatile',
})

// Anthropic without the official SDK
const claude = new HttpProvider({
  baseURL: 'https://api.anthropic.com/v1',
  apiKey: process.env.ANTHROPIC_API_KEY,
  dialect: 'anthropic',
  model: 'claude-sonnet-4-6',
})
```

`@namzu/http` supports dialects `openai` and `anthropic` at launch. `gemini` can be added later without breaking changes.

### Tag-prefix release scheme (extending ADR-less existing convention)

Each package follows the existing `<pkg>-v<semver>` tag-prefix scheme established in the monorepo bootstrap commit:

- `bedrock-v*` → `.github/workflows/release-bedrock.yml` → publishes `@namzu/bedrock`
- `openrouter-v*` → `release-openrouter.yml` → publishes `@namzu/openrouter`
- …and so on

Each package has its own release workflow, Trusted Publisher entry on npmjs.com, and independent `scripts/release.sh`.

### Unified streaming and tool-use semantics

Each vendor's official SDK speaks its own event shape (OpenAI deltas, Anthropic content blocks with `tool_use` start/input_delta/stop, Bedrock Converse events). Consumers of `LLMProvider` must not see these differences.

Every provider implementation is responsible for mapping vendor events into the sdk's normalized `StreamChunk` shape:

```ts
// @namzu/sdk
export type StreamChunk = {
  id: string
  delta: {
    content?: string
    toolCall?: { id: string; name?: string; arguments?: string }
  }
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter'
  usage?: TokenUsage
}
```

Adapter mapping rules (enforced by contract tests — see Test Strategy):

- Text deltas → `delta.content` concatenates to the full message text.
- Tool-call starts → new `delta.toolCall` with `id` + `name`.
- Tool-call argument streaming → subsequent chunks with same `toolCall.id` and `arguments` fragments.
- `finishReason` is required in the final chunk, never in intermediate chunks.
- Usage is emitted once, in the final chunk (or via separate accumulator if the vendor reports it async).

Any provider that cannot faithfully map these events (e.g. a hypothetical vendor that only reports tool-calls as a final JSON) must document the degradation in its README and set a `supportsStreamingToolCalls: false` capability flag.

### `@namzu/http` dialect selection and mismatch handling

`@namzu/http` requires an **explicit `dialect`** argument (`'openai' | 'anthropic'`). There is no auto-detection or probing on startup — probing costs a round-trip and surfaces "works-in-dev-breaks-in-prod" category failures.

If the server responds with a shape that doesn't match the declared dialect, `HttpProvider` throws `DialectMismatchError` with:

- The declared dialect
- A truncated sample of the actual response body
- The URL and HTTP status
- A hint: "Check your `dialect` argument matches the endpoint. Known dialects: 'openai' for OpenAI-compat (Ollama, LM Studio, vLLM, Groq, DeepInfra, OpenRouter), 'anthropic' for native Anthropic API."

This is fail-fast by design: silent coercion would corrupt tool-call arguments and content deltas.

## Test Strategy

Three layers of tests enforce correctness without requiring live API keys in CI:

### 1. Unit tests (every package)

Each provider package has unit tests against `MockFetch` (native test double over Node's `fetch`). Coverage includes:

- Request shape: headers, body JSON, URL construction, auth format.
- Response parsing: happy-path decode into `ChatCompletionResponse`.
- Streaming: SSE chunk parser against fixture `.sse` files.
- Error handling: 4xx/5xx mapping, network failure, truncated stream, malformed chunk.
- Registration: `register<Vendor>()` adds type to registry; double-register throws unless `{ replace: true }`.

### 2. Contract tests (shared suite)

`@namzu/sdk-contract-tests` (internal, not published) exports a conformance suite that every provider package imports and runs against its implementation. The suite verifies:

- `LLMProvider.chat(params)` returns conformant `ChatCompletionResponse`.
- `LLMProvider.chatStream(params)` yields `StreamChunk`s satisfying the normalization rules above.
- Tool-call streaming: given a multi-fragment tool-call fixture, the accumulated `arguments` match expected JSON.
- Finish reason is present in exactly one terminal chunk.
- Usage accumulation across streaming chunks is consistent.

Fixture data for each vendor lives in the vendor package's `src/__fixtures__/` (real responses captured once, committed as files). Contract tests are replay-only — no network in CI.

### 3. Smoke tests (opt-in, local)

Each package ships a `pnpm smoke` script that hits the real vendor API using env vars (`AWS_ACCESS_KEY_ID`, `OPENAI_API_KEY`, `OLLAMA_HOST`, etc.). These are **not run in CI** — they're for maintainer pre-release verification and user-facing "does my auth work?" troubleshooting.

`@namzu/ollama` smoke tests assume a local Ollama daemon is running. `@namzu/bedrock` smoke uses the user's AWS credentials. Skipped if env vars are absent.

## Support Policy

### `@namzu/sdk@0.1.x` deprecation

- **Active line:** `@namzu/sdk@1.x` (see version strategy below). New features, bug fixes, security patches land here.
- **`0.1.x` status:** receives **critical security backports only** until **2026-10-15** (6 months from `@namzu/sdk@1.0.0` release). After that, EOL — no further fixes. Users must migrate to 1.x for any new release.
- npm deprecation message added at EOL: `npm deprecate @namzu/sdk@"0.1.x" "Superseded by 1.x — see migration guide at …"`

### Version strategy — sdk jumps to `1.0.0`, not `0.2.0`

Because semver's caret operator on 0.x (`^0.2.0`) **does not** cover 0.3.0 (every 0.x minor is treated as breaking), provider packages pinning `"@namzu/sdk": "^0.2.0"` would force a republish of all provider packages on every sdk minor bump. This is operationally untenable for 7+ packages.

Moving sdk to `1.0.0` at the extraction boundary makes provider peer ranges (`"@namzu/sdk": "^1"`) correctly match all non-breaking sdk minors (`1.1`, `1.2`, …). Future sdk breaking changes require a 2.0.0 and coordinated provider updates — but that is rare by design.

- `@namzu/sdk@1.0.0` — extraction + registry pattern.
- Each provider package peers `"@namzu/sdk": "^1"` at `0.1.0`.
- Provider packages follow their own semver independently within that peer range.

### Interface evolution across packages

The `LLMProvider` interface in `@namzu/sdk` is **append-only** within a major version: new optional methods (e.g. `chatWithCache`, `listTools`) can be added without breaking providers. Breaking changes to the interface (renaming a method, changing return shape) require a major sdk bump (`2.0.0`) and coordinated provider releases.

The `StreamChunk` shape follows the same rule — new optional fields are safe; removing or retyping existing fields requires a major.

## Consequences

### Breaking change — `@namzu/sdk@1.0.0`

- `BedrockProvider` and `OpenRouterProvider` are removed from sdk exports. Consumers must migrate to `@namzu/bedrock` or `@namzu/openrouter`.
- `ProviderFactory` is renamed to `ProviderRegistry` with a registration-based API (no more hardcoded `type` literal union).
- `ProviderType` becomes an open `string` type. Static exhaustiveness checks against the literal union are no longer possible; users who need exhaustiveness define their own union on their side.
- `@aws-sdk/client-bedrock-runtime` dependency is removed from sdk. Users of `@namzu/bedrock` install it transitively.
- `PROVIDER_CAPABILITIES` static map is removed. Capabilities are registered alongside the provider class (second argument to `register()`).

### Migration path for `@namzu/sdk@0.1.x` users

Documented in sdk CHANGELOG and README:

```ts
// 0.1.x
import { ProviderFactory } from '@namzu/sdk'
const { provider } = ProviderFactory.create({ type: 'bedrock', region: 'us-east-1', ... })

// 1.0.0
import { ProviderRegistry } from '@namzu/sdk'
import { registerBedrock } from '@namzu/bedrock'

registerBedrock()  // once at app startup

const { provider } = ProviderRegistry.create({ type: 'bedrock', region: 'us-east-1', ... })
```

### Benefits

- **Core install footprint drops from ~10 MB to <1 MB.** SDK is effectively a ~200 KB zod-plus-interface bundle.
- **Local LLM support becomes first-class** via `@namzu/ollama`, `@namzu/lmstudio`, and `@namzu/http`.
- **Zero-dep path** exists via `@namzu/sdk` + `@namzu/http` for users in constrained environments.
- **Provider updates ship independently.** A bugfix in Bedrock's API doesn't require a core SDK release.
- **New vendor packages can be added by the community** under `@namzu-community/<vendor>` or as PRs.

### Costs

- **More packages to publish and maintain.** 7 new packages at v0.1.0 plus coordination for future minor/major bumps.
- **Per-package release ceremony** — each needs its own Trusted Publisher entry, release workflow, CHANGELOG, version alignment with the sdk peer range.
- **Breaking change forces a major bump** for any consumer already on `@namzu/sdk@0.1.x`. Mitigation: sdk 0.1.6 remains published and consumers can pin it; migration guide in CHANGELOG.
- **Documentation surface grows** — each package needs its own README with auth setup and example snippets.

### Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Vendor package falls behind core sdk interface evolution | Peer-range `"@namzu/sdk": "^1"` covers all non-breaking sdk minors; `LLMProvider` interface is append-only within a major; contract test suite runs every provider against every sdk release |
| Multiple packages drift in code style / release flow | Shared `release.sh` + `verify.sh` + `cliff.toml` templates copied from `@namzu/sdk`'s originals; monorepo-wide biome + tsconfig project references |
| Official SDK dep bloats a provider package | Each provider is self-contained; users install only what they use. Users who still want zero-dep use `@namzu/http`. |
| Registry pattern loses exhaustiveness of literal union | Accepted trade-off for extensibility. Documented in README; users can define local `type ProviderType = 'bedrock' \| 'openai'` if needed |

## Alternatives Considered

### Alternative 1: Single-package SDK with lazy dynamic imports

Keep all providers in `@namzu/sdk` but move heavy deps (`@aws-sdk`, `@opentelemetry/*`) to `optionalPeerDependencies` and load them via `await import()` when the corresponding provider is instantiated.

**Rejected because:**

- Still publishes one growing package — every new vendor SDK requires a core release.
- Consumers get confusing "peer dep missing" errors at runtime instead of a clean install-time signal.
- Package.json stays long and maintains false coupling — users scanning deps see unused providers.
- Doesn't match the precedent already set by `@namzu/computer-use` (which is a separate capability package, not a lazy-loaded module).

### Alternative 2: Pure `@namzu/http` with no vendor-specific packages

Ship only a generic HTTP provider covering all OpenAI-compat endpoints plus Anthropic. Users wire up whichever endpoint they need with `baseURL` + `dialect` + `apiKey`.

**Rejected because:**

- DX is worse for mainstream users ("what's the baseURL for Ollama again?") vs. `new OllamaProvider({ model })`.
- No path for vendor-specific features (OpenRouter's model fallback config, Anthropic's extended thinking, LM Studio's model loading API).
- Reinventing what each vendor's official SDK already handles (streaming, retries, typed responses).
- AWS Bedrock requires SigV4 signing — implementable in pure fetch but not worth reimplementing when `@aws-sdk/client-bedrock-runtime` is battle-tested.

### Alternative 3: Vendor-per-package but no `@namzu/http`

Only ship dedicated vendor packages. Users who want a non-covered endpoint (self-hosted vLLM, niche OpenAI-compat gateway) implement `LLMProvider` themselves.

**Rejected because:**

- Users in zero-dep environments (edge runtimes, constrained containers) have no path.
- Self-hosted inference servers proliferate; covering all of them with dedicated packages is unbounded work.
- `@namzu/http` is near-trivial to implement and covers the long tail cleanly.

### Alternative 4: Fork/vendor AWS SDK's SigV4 into `@namzu/bedrock` for zero-dep

Instead of depending on `@aws-sdk/client-bedrock-runtime`, inline the SigV4 signing logic and call Bedrock's REST endpoint directly with native `fetch`.

**Rejected (for v1) because:**

- User directive: use the vendor's official SDK where one exists. Each vendor package's dep is opt-in by its install.
- Users who truly want zero-dep AWS can use `@namzu/http` + aws4fetch themselves, or open a community `@namzu/bedrock-lite` package.
- Maintaining a SigV4 implementation inside `@namzu/bedrock` is real crypto-edge-case work. The AWS SDK is battle-tested against real AWS edge cases (temporary credentials, session tokens, IMDS).
