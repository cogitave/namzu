# Changelog

## 0.4.2

### Patch Changes

- 14ff062: Public-surface barrel split (ses_011-sdk-public-surface).

  **Note on bump level.** Originally classified as minor when ses_011 froze on 2026-04-21. Downgraded to patch post-freeze (2026-04-21) as part of a repo-wide release-cadence policy decision: the pre-1.0 SDK reserves minor/major for feature-delta releases, and internal refactors that keep the public-surface baseline intact ride patch. This changeset explicitly preserved all 380 pre-existing public names (verified by `.github/scripts/verify-public-surface.mjs`), so patch is semver-accurate at the name-set level. See `.changeset/sdk-replay-primitive.md` for the same-day rationale block.

  `packages/sdk/src/index.ts` splits from 357 lines of mixed re-exports into three focused bucket files, consumed through a thin 10-line root barrel:

  - **`public-types.ts`** — every type a consumer type-checks against (branded IDs, wire shapes, domain entities, store contracts, event unions, config types).
  - **`public-runtime.ts`** — every runtime value (classes, functions, constants, zod schemas, error classes, ID generators).
  - **`public-tools.ts`** — agent-tool surface (`defineTool` primitive, built-in tools, domain builders, connector tool bridge, `createRAGTool`).

  No consumer-visible change. All 380 previously-exported names continue to be exported; none removed, none added. Verified by a baseline snapshot (`.github/scripts/public-surface-baseline.json` — captured at the tip of ses_010) plus a CI smoke test (`.github/scripts/verify-public-surface.mjs`) that loads `@namzu/sdk` at runtime and compares `Object.keys()` against the baseline.

  Additional cleanup:

  - The `ProjectId` / `RunId` / `MessageId` / `SessionId` double-channel (reachable through both `contracts/` and `types/ids/`) is closed. IDs come from `types/ids/` uniformly; `contracts/ids.ts` is deleted; `contracts/api.ts` imports IDs from `../types/ids/` directly.
  - The `RunStatus` carve-out is folded. Since ses_010 renamed the wire-side alias to `WireRunStatus`, the domain `RunStatus` can flow through `types/run/index.ts` with a plain `export *` — no explicit carve-out needed.

- 2eccadd: Replay primitive v1 — fork an existing run from any stored checkpoint with optional mutation at the fork point (ses_005-deterministic-replay).

  **Note on bump level.** This release adds new public exports (`prepareReplayState`, `listCheckpoints`, `projectEmergencyToCheckpoint`, `MutationNotApplicableError`, the `Mutation` / `CheckpointListEntry` / `ReplayAttribution` types, `Run.replayOf?`). In strict semver these would be a minor bump. Classified as patch here because the SDK is pre-1.0 and the project reserves minor/major for larger feature deltas — 0.5.0 should land with a more complete replay surface (5b end-to-end wrapper, reproduce mode, or similar) rather than just this state-preparation half. Decision logged 2026-04-21 post-freeze of ses_005.

  New public runtime values:

  - **`prepareReplayState({ baseDir, runId, fromCheckpoint, mutate?, emergencyDir? })`** — pure-read helper that resolves `fromCheckpoint` (`CheckpointId | 'latest' | 'emergency'`), applies mutations, and returns `{ messages, sourceCheckpoint, attribution }` ready to thread into a `query(...)` call.
  - **`listCheckpoints({ baseDir, runId })`** — lists a run's checkpoints as lightweight `CheckpointListEntry` projections.
  - **`projectEmergencyToCheckpoint(dump)`** — project an `EmergencySaveData` snapshot to an `IterationCheckpoint` shape with deterministic `cp_emergency_*` id.
  - **`MutationNotApplicableError`** — thrown by `prepareReplayState` when a mutation targets a tool call that is not pending at the fork point; carries `availableToolCallIds` for recovery.

  New public types:

  - **`Mutation`** — discriminated union; single `injectToolResponse` variant in v1.
  - **`CheckpointListEntry`** — listing projection distinct from the pre-existing HITL `CheckpointSummary`.
  - **`ReplayAttribution`** — `{ sourceRunId, fromCheckpointId, mutations, replayedAt }` record.
  - **`Run.replayOf?: ReplayAttribution`** — optional attribution field; `undefined` on original runs.

  Scope and non-scope — v1 ships **forked execution from a captured checkpoint, not byte-for-byte reproduction**. Past the fork point, provider calls and tool calls execute live. Deterministic reproduce mode is deferred to a follow-up session.

  A single-call `replay({ runId, opts })` wrapper is intentionally not shipped in v1. Composing `listCheckpoints → prepareReplayState → caller-owned query()` is the v1 flow; the wrapper requires a `ReplayEnvironment` design (provider, tools, resume handler, session scope) that lands in a follow-up session.

  See `docs/sdk/runtime/replay.md` for the full primitive docs, determinism envelope, and non-scope.

- 9efae03: Type layering rationalised (ses_010-sdk-type-layering).

  **Note on bump level.** Originally classified as minor when ses_010 froze on 2026-04-21. Downgraded to patch post-freeze (2026-04-21) as part of a repo-wide release-cadence policy decision: the pre-1.0 SDK reserves minor/major for feature-delta releases, and internal refactors that keep the public-surface baseline intact ride patch. This changeset introduced no consumer-visible new names and renamed `AgentRun → Run` with a `@deprecated` alias, which the policy treats as a patch-level churn for 0.x. See `.changeset/sdk-replay-primitive.md` for the same-day rationale block.

  All pure shapes — entities, store contracts, wire types, events — now live under `packages/sdk/src/types/`. Feature folders (`session/`, `manager/`, `store/`, `agent/`, `provider/`) contain runtime code only.

  **Public surface changes:**

  - `AgentRun` renamed to `Run`. `AgentRun` and `AgentSession` are kept as `@deprecated` type aliases for the 0.4.x compatibility window — existing code importing either continues to compile. New code should use `Run`.
  - Wire-side `Run` interface renamed to `WireRun`, mirroring the existing `WireRunStatus` precedent. The root `@namzu/sdk` barrel now exports domain `Run` and wire `WireRun` with no collision.
  - Internal folder `packages/sdk/src/session/hierarchy/` removed. Only the `@namzu/sdk` root barrel (`.`) is a supported import surface; deep-imports were never supported and the old path no longer exists.

  No runtime behaviour change. Every entity previously exported (`Project`, `Thread`, `Session`, `SubSession`, `ActorRef`, `Lineage`, `Tenant`) continues to be exported from `@namzu/sdk`.

## Unreleased

### Minor Changes

- ses_010-sdk-type-layering: Type layering rationalised. All pure shapes (entities, store contracts, wire types, events) now live under `packages/sdk/src/types/`; feature folders under `session/`, `manager/`, `store/`, `agent/`, `provider/` contain runtime code only.

  Public surface changes:

  - `AgentRun` renamed to `Run`. `AgentRun` and `AgentSession` remain as `@deprecated` type aliases for the 0.4.x compatibility window; consumers importing either keep compiling. New code should use `Run`.
  - The wire-side `Run` interface at `contracts/api.ts` renamed to `WireRun` — mirrors the existing `WireRunStatus` precedent. The root `@namzu/sdk` barrel now exports domain `Run` (from `types/run/`) and wire `WireRun` (from `contracts/`) with no same-symbol collision.
  - Internal folder `packages/sdk/src/session/hierarchy/` removed. Only the `@namzu/sdk` root barrel (`.`) is a supported import surface; deep-imports were never supported and the path no longer exists.

  No change to runtime behaviour. Every entity shape that used to live under `session/hierarchy/` (`Project`, `Thread`, `Session`, `SubSession`, `ActorRef`, `Lineage`, `Tenant`) continues to be exported from `@namzu/sdk` — only the internal folder structure moved.

## 0.4.1

### Patch Changes

- c9b180d: Coordinated patch bump across all publishable packages after the `@namzu/telemetry@0.1.0` extraction landed. No functional changes — this is a compatibility and release-pipeline validation cut to (a) exercise the Trusted Publisher binding for `@namzu/telemetry` that was configured after the 0.1.0 bootstrap publish, and (b) give consumers a single aligned set of patch versions that all know about the new telemetry package.

  Resulting versions:

  - `@namzu/sdk` → `0.4.1`
  - `@namzu/telemetry` → `0.1.1`
  - `@namzu/computer-use` → `0.2.1`
  - `@namzu/anthropic`, `@namzu/bedrock`, `@namzu/http`, `@namzu/lmstudio`, `@namzu/ollama`, `@namzu/openai`, `@namzu/openrouter` → `0.1.2`

## 0.4.0

### Minor Changes

- 96e3f84: **BREAKING**: OpenTelemetry SDK and exporters extracted to `@namzu/telemetry`. `zod` and `zod-to-json-schema` moved to `peerDependencies`. `@opentelemetry/api` moved to `peerDependencies`.

  All removed exports have a replacement in `@namzu/telemetry`:

  | Removed                                    | Import from `@namzu/telemetry`             |
  | ------------------------------------------ | ------------------------------------------ |
  | `TelemetryProvider`                        | `TelemetryProvider`                        |
  | `initTelemetry` (sync)                     | `registerTelemetry` (async — **await it**) |
  | `getTelemetry`, `getTracer`, `getMeter`    | same names                                 |
  | `createPlatformMetrics`, `PlatformMetrics` | same names                                 |
  | `TelemetryConfig`, `ExporterType`          | same names                                 |
  | `GENAI`, `NAMZU`, span-name helpers        | `@namzu/telemetry/attributes` subpath      |

  Install-surface delta: `@namzu/sdk` runtime deps 10 → 0. Consumers who don't emit telemetry and don't use Zod directly install 0 extra packages from the SDK tree. See [`docs/migration/0.4.md`](https://github.com/cogitave/namzu/blob/main/docs/migration/0.4.md) for the full upgrade path.

  Related: `@namzu/telemetry@0.1.0` initial publish ships in the same release.

## 0.3.0

### Minor Changes

- 40eb841: Unblock BYO-provider use of `AgentManager.spawn` and capture the full 0.2.x → 0.3.0 window.

  **Bug Fixes**

  - `AgentManager.sendMessage` no longer requires both `configBuilder` AND `factoryOptions` together. The configBuilder now runs whenever it is registered; `factoryOptions` defaults to `{}` when absent. This closes the silent crash path that consumers following README's "getting started" install hit with Bedrock (ERESOLVE → bare-config → ReactiveAgent null access).
  - `AgentFactoryOptions.apiKey` is now optional. BYO-provider flows (Bedrock IAM, custom `ProviderRegistry.create(...)`) no longer need to fabricate a meaningless empty `apiKey` just to satisfy the type.

  **Breaking Changes carried over from the 0.2.x → 0.3.0 window**

  - `feat(sdk)!: propagate threadId through runtime + wire archive gate` — childConfig now receives `sessionId/threadId/projectId/tenantId` automatically from the parent context (stamped by AgentManager after configBuilder returns). configBuilder implementations that previously emitted these fields manually are unaffected; implementations relying on the old 0.2.0 three-ID triple (`sessionId/projectId/tenantId` without `threadId`) will now see `threadId` populated on the child config.

  **Other**

  - `knip` integrated as the dead-code detector (dev-only, no runtime surface change).
  - `ThreadManager.archive`/`delete` primitives added to `SessionStore`; wire-side `thread_id` renamed during the Thread→Project wire refactor (internal rename).

  See commits since `sdk-v0.2.0` for the full list; this changeset captures the visible-to-consumer summary.

All notable changes to Namzu are documented here.

## [0.2.0] — 2026-04-17

### Features

- **sdk**: close Task 10 known deltas + expose session hierarchy (Phase 9) [**BREAKING**]
- **sdk**: add retention + archival primitives with deleteSession close-out (Phase 8)
- **sdk**: add migration utilities for 0.2.0 upgrade path (Phase 7)
- **sdk**: refactor AgentManager to spawn SubSession triple with kernel summarization (Phase 6) [**BREAKING**]
- **sdk**: add SessionSummaryMaterializer kernel terminalization primitive (Phase 5)
- **sdk**: add handoff state machine with atomic broadcast rollback (Phase 4)
- **sdk**: add SessionStore + PathBuilder + git-worktree workspace driver (Phase 3) [**BREAKING**]
- **sdk**: add RunEvent schemaVersion + sub-session lifecycle events (Phase 2) [**BREAKING**]
- **sdk**: introduce session hierarchy type foundation (Phase 1) [**BREAKING**]

### Testing

- **sdk**: add Task 10 integration test coverage matrix (Phase 10)

## [0.1.8] — 2026-04-15

### Documentation

- **changelog**: update for sdk-v0.1.7
- **readme**: rewrite root + fix sdk stale ProviderFactory refs

## [0.1.7] — 2026-04-15

### Documentation

- **changelog**: add 0.1.6 (sdk) and 0.1.0 (computer-use) entries; fix cliff tag prefix + workflow race
- **changelog**: update for sdk-v0.1.6-rc.1

### Features

- **bedrock**: extract BedrockProvider to @namzu/bedrock package (Phase I.3 pilot)
- **openrouter**: extract OpenRouterProvider to @namzu/openrouter package (Phase I.4)

### Refactor

- **sdk**: address Codex review — scope providers/ subfolder, hide registry reset
- **sdk**: replace ProviderFactory with ProviderRegistry for per-vendor extraction [**BREAKING**]

## [0.1.6-rc.1] — 2026-04-15

### Documentation

- **changelog**: update for v0.1.5

### Features

- **sdk**: add ComputerUseHost interface and computer_use tool

### Miscellaneous

- initialize namzu monorepo from sdk; add @namzu/computer-use capability package

## [0.1.5] — 2026-04-15

### Bug Fixes

- **emergency**: uuid tmp suffix, outer try/catch, and explicit exit
- **store**: resolve withLock race, delete deadlock, and atomic edge updates

### Documentation

- **changelog**: update for v0.1.5-rc.2

### Refactor

- **barrels**: route root barrel through sub-barrels (Path B)
- **connector**: brand ConnectorId/TenantId on public interfaces [**BREAKING**]

### Testing

- **store**: add concurrency regression tests for DiskTaskStore

## [0.1.5-rc.2] — 2026-04-14

### Bug Fixes

- **plugin**: wire MCP servers and fail fast on unsupported contributions
- **plugin**: consume hook results and wire tool hooks in runtime
- **release**: normalize pre-release counter to strip non-digit suffix

### Documentation

- **changelog**: update for v0.1.5-rc.1-fix
- **contracts**: formalize wire/domain duality + refresh README
- **readme**: rewrite code examples to match current SDK API

### Refactor

- **plugin**: remove duplicate PluginConfigSchema in types/
- **registry**: migrate Agent/Connector/Tool registries to ManagedRegistry
- **run**: remove legacy Session\* aliases for run-centric classes

## [0.1.5-rc.1] — 2026-04-12

### Documentation

- **changelog**: update for v0.1.4

### Refactor

- architectural cleanup and infrastructure improvements

## [0.1.4] — 2026-04-11

### Documentation

- **changelog**: update for v0.1.4-rc.3

### Features

- sandbox isolation, new tools (edit/grep/ls), session-to-run migration

## [0.1.4-rc.3] — 2026-04-10

### Miscellaneous

- **release**: derive version from git tag, no manual bump needed

## [0.1.4-rc.2] — 2026-04-10

### Bug Fixes

- **ci**: remove duplicate --strip flag in git-cliff command
- **plugin**: rename session hooks to run_start/run_end
- **release**: use tag name as release title instead of prefixed name

### Features

- P3 + plugin architecture — emergency save, memory index, plugin system
- P2 — AgentBus, prompt cache split, verification gate
- integrate compaction loop and advisory phase into iteration pipeline

### Miscellaneous

- **changelog**: automate CHANGELOG.md via git-cliff in release workflow

## [0.1.4-rc.1] — 2026-04-10

### Bug Fixes

- add description field to package.json, reorder README badges

### Features

- **advisory**: provider-agnostic advisory system with three-layer architecture
- structured compaction, tool tiering, task router
- output discipline, shell compression, pre-release workflow

### Miscellaneous

- remove BEFORE-RELEASE.md from repo

## [0.1.3] — 2026-04-10

### Bug Fixes

- point entry fields to dist/ for bundler compatibility

### Documentation

- add npm, ci, license, typescript, node badges to README

## [0.1.2] — 2026-04-10

### Other

- Namzu v0.1.1 — Wisdom, shared

Open-source AI agent framework by cogitave.

Let's build the agent layer together.

### Refactor

- constants centralization, strict lint, release automation
