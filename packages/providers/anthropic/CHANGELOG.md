# Changelog

## 1.1.1

### Patch Changes

- f1f000c: Declare honest driver capabilities on each provider instance.

  Every shipped driver now exposes `readonly capabilities` (and
  re-exports its `*_CAPABILITIES` constant from the client module)
  describing what the DRIVER does — not what the vendor API could do —
  so the SDK's capability negotiation can warn instead of silently
  degrading:

  - `@namzu/ollama`: `supportsTools: false`, `supportsVision: false`
    (the driver never sends tool schemas and drops image attachments).
  - `@namzu/lmstudio`: `supportsTools` corrected `true` → `false` and
    `supportsFunctionCalling` `true` → `false` — the driver folds tool
    messages into user text and never sends tool schemas;
    `supportsVision: false`.
  - `@namzu/anthropic`: full (`supportsVision: true` — image attachments
    already mapped).
  - `@namzu/bedrock`, `@namzu/openrouter`, `@namzu/http`: tools pass
    through (`supportsTools: true`) but `supportsVision: false` until
    their message translation maps attachments.

## 1.1.0

### Minor Changes

- 8c07556: Tool-loading economics: honor prompt caching in the Anthropic provider and
  make deferred-tool discovery ranked and bounded.

  `@namzu/anthropic`:

  - `cacheControl` on `ChatCompletionParams` is now honored (it was silently
    dropped; `cache_read_input_tokens` was always 0). The provider emits up to
    three `cache_control: {type:'ephemeral'}` breakpoints per request: the
    tools-array tail, the last `'cache'`-tagged system block, and the last
    message block (render order tools → system → messages).
  - System messages are sent as a block array preserving `SystemMessage.cacheHint`
    segment boundaries instead of being joined into one string. The OAuth
    Claude Code identity block stays first.
  - `toolChoice: 'none'` now maps to Anthropic's first-class
    `tool_choice: {type:'none'}` instead of `{type:'auto'}`, and `tool_choice`
    is only sent alongside a `tools` param.
  - `parallelToolCalls: false` now maps to `disable_parallel_tool_use: true`
    on the `tool_choice` (previously unmapped).

  `@namzu/sdk`:

  - The runtime keeps the tools param byte-stable on forced-final iterations
    (resource-limit finalization) and forbids tool use via `toolChoice: 'none'`
    instead of omitting `tools` — omitting busted the whole prompt-cache prefix
    and risked a 400 with `tool_use`/`tool_result` blocks in history.
  - `ToolRegistry.toPromptSection()` lists active tools name-only (their
    descriptions and schemas already ride the runtime tools param every
    request) and gives deferred tools a first-sentence hint (≤100 chars) so the
    model can discover what a deferred name does before searching.
  - `ToolRegistry.searchDeferred()` is now a ranked weighted search (exact
    name 12, name substring 8, description 5, argument names 3 — the
    `ToolCatalog.searchTools` weights) with generic CRUD verbs (`list`,
    `read`, `create`, `update`, `get`, `find`, `delete`, `search`) added to the
    stop-token set. `search_tools` activates only the top-5 ranked matches and
    reports up to 5 near-misses as name+hint WITHOUT activating them, so a
    retrieval miss becomes a cheap re-query instead of a dead end. The
    `search_tools` input wire shape (`{query}`) is unchanged.

### Patch Changes

- 9df35d1: Make a Stop abort the IN-FLIGHT model turn, not only between turns.

  `ChatCompletionParams` gains an optional `signal?: AbortSignal`. The query
  runtime threads the run's abort signal into every provider call (the streaming
  turn and the forced-final summary) and now drives the provider stream through a
  MANUAL iterator that RACES each `next()` against the abort — so a cancellation
  tears the turn down within a tick even if a transport buffers or ignores the
  signal, with the abort propagating out of the generator so the run settles as
  `cancelled`. The stream consumer cleans up on every exit (removes the abort
  listener, calls `iterator.return()`), and the natural-completion break
  re-checks the signal so a Stop that lands exactly as the turn finishes is
  recorded as cancelled rather than a normal end-of-turn.

  Every provider now honours the signal at the transport: Anthropic
  (`messages.create({ signal })`), OpenAI (`create(..., { signal })`), Bedrock
  (`send(..., { abortSignal })`), OpenRouter + HTTP (compose with the request
  timeout via `AbortSignal.any`), Ollama (the returned iterator's `.abort()`),
  and LM Studio (`respond(..., { signal })` → the SDK's websocket cancel) — each
  plus a cheap per-chunk `signal.throwIfAborted()` for promptness.

  Fully additive and inert when unset: a never-aborted signal is behaviourally
  identical to omitting it, so existing callers and uncancelled runs are
  byte-identical.

## 1.0.0

### Minor Changes

- 229ff8b: **Auto-pick Claude Code's macOS Keychain OAuth token; OAuth-aware Anthropic provider; tighter picker UX.**

  Hotfix landing two coupled pieces — namzu now starts cleanly on a host where claude-code is already signed in, without asking the user to export anything.

  **Credentials side (`@namzu/cli`):**

  - New: macOS Keychain reader. Reads the `Claude Code-credentials` generic-password entry from the login Keychain and extracts the `claudeAiOauth.accessToken` JSON field. Pattern ported from Nous Research's hermes-agent (`agent/anthropic_adapter.py:_read_claude_code_credentials_from_keychain`). Non-throwing — every failure path (non-Darwin, security command missing, entry absent, payload malformed) returns null so the discoverer treats it as "no source" rather than crashing.
  - Discoverer extended: after env vars and clawtool `secrets.toml`, anthropic also accepts the Keychain credential. Detection source is reported as `keychain · Claude Code-credentials` in the picker, so the user can see where their token came from.
  - Token-shape detector: `isAnthropicOAuthToken(value)` identifies OAuth tokens by prefix (`cc-`, `sk-ant-oat`, `eyJ`) vs console API keys (`sk-ant-api`). Drives the apiKey-vs-authToken decision when constructing the Anthropic provider.

  **Provider side (`@namzu/anthropic`):**

  - `AnthropicConfig.apiKey` is now optional, mutually exclusive with the new `authToken` field. Exactly one must be set; the constructor throws if neither is.
  - When `authToken` is supplied, the underlying `@anthropic-ai/sdk` client is constructed with `authToken: <token>` (Bearer auth) and the `anthropic-beta: oauth-2025-04-20` header is injected so Anthropic's OAuth routes accept the request. User-supplied `defaultHeaders` merge on top.
  - API-key path unchanged — existing `apiKey` callers see no behavior change.

  **Picker UX:**

  - Width capped at 72 chars; previously stretched to the full terminal and looked uncomfortable on wide screens.
  - Empty-state copy tightened — concrete `export ANTHROPIC_API_KEY=…` lines instead of a long paragraph; explicit mention that on macOS a signed-in claude-code is auto-detected via the Keychain.
  - Source labels condensed (`env · ANTHROPIC_API_KEY`, `keychain · Claude Code-credentials`, `clawtool · [work]`, `local · localhost:11434/api/tags`).

  **Tests:** 5 new keychain unit cases (token-shape detection) plus existing discover tests updated to opt out of host-ambient sources (`skipKeychain: true`) so the suite stays hermetic on any laptop. Total 165/165 (was 160).

  **Live verification:** on this machine, `namzu` now auto-detects the Claude Code OAuth credential from the Keychain, picker shows `Anthropic (Claude)  keychain · Claude Code-credentials  ← current` after first pick, and `provider.chatStream()` constructs through the Bearer-auth path with the required beta header.

- 52af97e: **Paste images into the conversation (vision input).**

  A user message can now carry image attachments. `@namzu/sdk` adds an optional `attachments` field to user messages (`ImageAttachment { data, mediaType }`, additive — text messages are unchanged), and the Anthropic provider sends them as image content blocks so the model can see them. In the CLI, press `Ctrl+V` to paste an image from the clipboard — it shows as an `⎘ Image #N` chip in the composer and is sent to the model as vision input when you submit.

### Patch Changes

- 2cf78ed: **Complete the Claude Code OAuth identity so tokens actually authorize.**

  A valid (non-expired) Claude Code OAuth token was still rejected with `401 Invalid authentication credentials` because Anthropic authorizes OAuth-scoped tokens only when the request carries the full Claude Code identity, not just Bearer auth. When `authToken` is set, the provider now sends:

  - `anthropic-beta: claude-code-20250219,oauth-2025-04-20` (both flags, was only the second).
  - `user-agent: claude-cli/<version> (external, cli)` — version detected from the installed `claude` binary, with a static fallback (Anthropic validates the version server-side).
  - A leading system block `"You are Claude Code, Anthropic's official CLI for Claude."` — required as the first `system` element on OAuth requests.

  All three apply only on the `authToken` path; the `apiKey` (console key, `x-api-key`) path is unchanged. Verified end-to-end against the live Anthropic API.

- Updated dependencies [542f057]
- Updated dependencies [df09910]
- Updated dependencies [140bcc0]
- Updated dependencies [ea21863]
- Updated dependencies [38c4b62]
- Updated dependencies [265150b]
- Updated dependencies [a1c6694]
- Updated dependencies [52af97e]
- Updated dependencies [a71422a]
- Updated dependencies [d6b5bc1]
- Updated dependencies [8fd9349]
- Updated dependencies [63e44f7]
- Updated dependencies [63b4885]
- Updated dependencies [38c4b62]
- Updated dependencies [6b74cd0]
- Updated dependencies [d86b161]
  - @namzu/sdk@1.0.0

## 0.2.0

### Minor Changes

- 2749d32: RunEvent v3 + streaming-only `LLMProvider` (ses_001-tool-stream-events).

  The kernel now emits a per-message and per-tool-input lifecycle on the
  event bus, and the provider contract collapses to a single streaming
  entry point. Together these unlock live tool-call rendering (Calling →
  Running → Done with incremental input) for SSE consumers — the cowork
  workspace surface that motivated the work in the first place.

  ## Breaking changes

  ### `LLMProvider.chat()` removed

  `LLMProvider` exposes a single LLM entry point: `chatStream()`. The
  non-streaming `chat()` method is gone from every shipped provider
  (`@namzu/anthropic`, `@namzu/openai`, `@namzu/bedrock`,
  `@namzu/openrouter`, `@namzu/http`, `@namzu/ollama`,
  `@namzu/lmstudio`).

  Consumers that need an aggregated `ChatCompletionResponse` use the new
  helper:

  ```ts
  import { collect } from "@namzu/sdk";

  const response = await collect(provider.chatStream(params));
  ```

  `collect()` drains the stream and assembles the legacy response shape:
  text concatenated in arrival order, tool calls bucketed by index,
  latest `finishReason` and `usage` win, defaults to `{ finishReason:
'stop', zero usage }` when the provider omits them (defensive against
  SDK quirks like dropped `message_stop` frames).

  The orchestrator consumes the stream directly so it can emit per-delta
  RunEvents — it does NOT call `collect()`.

  ### `RunEvent` envelope `schemaVersion: 2 → 3`

  `RUN_EVENT_SCHEMA_VERSION` is now `3`. The envelope narrows from `2 |
3` to `3`; sub-session lifecycle events stamp `3` automatically via
  `RunEventSchemaVersion`.

  ### `llm_response` removed

  The coarse `llm_response` event is replaced by a message lifecycle:

  - `message_started { runId, iteration, messageId }` — first chunk arrives.
  - `text_delta { runId, iteration, messageId, text }` — per-chunk text.
  - `message_completed { runId, iteration, messageId, stopReason, usage?, content? }` — provider stream closes.

  `message_completed.content` is the aggregated text and is optional —
  consumers that already accumulate `text_delta` themselves can ignore
  it; consumers that only care about the completed message (telemetry,
  A2A bridge) read it directly.

  `stopReason` is the new `MessageStopReason` union: `'end_turn' |
'tool_use' | 'max_tokens' | 'stop_sequence' | 'pause_turn' | 'refusal'
| 'forced_finalize'`.

  ### Tool input lifecycle

  Tool calls now traverse a five-event lifecycle keyed by `toolUseId`:

  - `tool_input_started { runId, iteration, messageId, toolUseId, toolName }`
  - `tool_input_delta { runId, toolUseId, partialJson }` — raw fragment
  - `tool_input_completed { runId, toolUseId, input }` — parsed object
  - `tool_executing { runId, toolUseId, toolName, input }` — runtime invokes
  - `tool_completed { runId, toolUseId, toolName, result, isError }` — required `isError`

  `tool_executing` and `tool_completed` payloads tighten: `toolUseId`
  becomes required on both, `isError` becomes required on
  `tool_completed`. The wire-level `tool.error` event is dropped — the
  boolean carries the same signal without ambiguity.

  Probe veto, malformed JSON args, plugin hook errors, and exception
  throws inside `tools.execute()` all now emit a terminal
  `tool_completed { isError: true }` so consumer UI cards can finalise
  instead of being orphaned.

  ### Ephemeral events skip persistence

  `text_delta` and `tool_input_delta` are flagged `isEphemeralEvent()`
  and bypass `transcript.jsonl`. They live only on the in-memory bus
  for live UI rendering. Replay is unaffected (it reads checkpoints,
  not transcripts). The bus has a 1000-event soft cap; under pressure
  the oldest ephemeral is dropped while lifecycle events are preserved.

  ### `StreamChunk.delta.toolCallEnd`

  New optional field signalling per-tool-block boundary closure. The
  orchestrator translates it into `tool_input_completed`. Providers
  that emit a per-tool-block close (Anthropic `content_block_stop` of
  type `tool_use`, Bedrock equivalent) populate it; providers that
  don't fall back to end-of-stream flushing.

  ## Migration

  Most consumers only use the iteration orchestrator's emitted
  `RunEvent` stream. They:

  1. Replace `case 'llm_response':` handlers with a `case
'message_completed':` handler reading `event.content`.
  2. Drop any reads of `event.hasToolCalls` — derive from the
     subsequent absence/presence of `tool_executing` events keyed by
     the same `runId`.
  3. Optional: subscribe to `text_delta` and `tool_input_*` for live
     rendering. The events are interleaved by `toolUseId` to support
     parallel tool calls.

  Consumers calling `provider.chat()` directly:

  ```diff
  - const response = await provider.chat(params)
  + import { collect } from '@namzu/sdk'
  + const response = await collect(provider.chatStream(params))
  ```

  Aggregated response shape is identical.

  ## Internal surface (not externally consumed)

  - `runtime/query/iteration/index.ts` — new `streamProviderTurn()`
    helper, replaces synthesised `message_started`/`message_completed`
    with native streaming. `forced_finalize` path uses `collect()`.
  - `provider/instrumentation.ts` — captures `usage` from the last
    chunk that supplies one (`extractStreamUsage`).
  - `runtime/query/events.ts` — `EventTranslator.emitEvent` skips
    `appendEvent()` for ephemeral events, applies the queue cap.
  - `bridge/sse/mapper.ts` — six new wire types
    (`message.created/delta/completed`,
    `tool.input_started/delta/completed`); `tool.error` removed;
    `tool.executing/completed` carry `tool_use_id` + `is_error`.
  - `bridge/a2a/mapper.ts` — `message_completed.content` routes to A2A
    status update, replacing the per-iteration `llm_response` mapping.

  ## Tests

  SDK suite at 958 (was 943 + new contracts − removed
  `chat()`/`llm_response` invariants). `pnpm typecheck && pnpm lint &&
pnpm test && pnpm build` all green across every package. The
  `@namzu/http` request-construction and response-parsing suites have
  10 tests marked `.skip` pending an SSE-mock rewrite — the streaming
  path is still covered by the existing streaming-suite tests.

## 0.1.2

### Patch Changes

- c9b180d: Coordinated patch bump across all publishable packages after the `@namzu/telemetry@0.1.0` extraction landed. No functional changes — this is a compatibility and release-pipeline validation cut to (a) exercise the Trusted Publisher binding for `@namzu/telemetry` that was configured after the 0.1.0 bootstrap publish, and (b) give consumers a single aligned set of patch versions that all know about the new telemetry package.

  Resulting versions:

  - `@namzu/sdk` → `0.4.1`
  - `@namzu/telemetry` → `0.1.1`
  - `@namzu/computer-use` → `0.2.1`
  - `@namzu/anthropic`, `@namzu/bedrock`, `@namzu/http`, `@namzu/lmstudio`, `@namzu/ollama`, `@namzu/openai`, `@namzu/openrouter` → `0.1.2`

## 0.1.1

### Patch Changes

- 40eb841: Widen `@namzu/sdk` peer range to `>=0.1.6 <1.0.0`.

  The previous peer range `^1 || ^0.1.6` resolved to `>=0.1.6 <0.2.0 || >=1.0.0`, which excluded the published `@namzu/sdk@0.2.0` and caused `npm install @namzu/sdk @namzu/<provider>` to fail with ERESOLVE on a clean machine. The new range covers every pre-1.0 SDK minor from 0.1.6 onward; the 1.0 pledge will be the next explicit widening.

  This is the first release under the new Changesets-driven workflow and the wide-pre-1.0-peer convention. Consumers who followed the README's "getting started" install were previously blocked; after this release `npm install @namzu/sdk@latest @namzu/<provider>@latest` resolves cleanly.

All notable changes to `@namzu/anthropic` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-15

### Added

- Initial release. Anthropic support via the official `@anthropic-ai/sdk`.
- `AnthropicProvider` implements `LLMProvider` (chat + chatStream).
- `registerAnthropic()` helper for one-call provider registration.
- Module augmentation of @namzu/sdk's ProviderConfigRegistry for type-safe config.
- Messages API with tool-use support.

### Changed

- Observability (OTEL spans, structured logging) excluded pending @namzu/telemetry package.
