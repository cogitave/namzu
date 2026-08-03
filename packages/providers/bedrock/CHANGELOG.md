# Changelog

## 2.0.0

### Major Changes

- 935b8f3: Three controls a caller could set that the runtime then quietly declined to apply.

  - **`toolChoice: 'none'` permitted tool calls on two drivers.** It means the model must not call a tool. One driver mapped it to the wire's "auto" and the other to `{ type: 'auto' }` — both of which say the model _may_. A caller that had forbidden tool use got a request that allowed it, with nothing in the response to say so. The runtime depends on the guarantee: an advisory consultation passes `'none'` so the advisor answers in prose, into a turn where no executor is waiting for a tool call. Both drivers now answer `'none'` by sending no tools at all, which no wire format can misread.

  - **`memoryLimitMb` and `maxProcesses` were dropped by the stronger isolation tiers.** They were applied inside the unconfined tier's branch only, so asking for namespace or profile isolation silently removed the blast-radius caps — a control failing in the one direction nobody checks. They are the same shell builtin on every tier; the stronger tiers now apply them one level in, inside the wrapper they already spawn through, and keep doing their own job. The sibling backend in the sandbox package already refuses per-sandbox controls it cannot enforce rather than ignoring them; this is the same rule, satisfied by enforcing.

  - **`AgentManager.dispose()` cancelled nothing.** It called `cancelAll('' as RunId)`, and `cancelAll` filters by parent run — no task has an empty parent, so it matched nothing, and the next lines cleared the instance map. Every live child was released without its abort controller firing: the work kept running, the budget kept draining, and nothing was left holding a reference to stop it. It now cancels every live child before dropping them. `cancelAll` stays scoped to one parent, which is its actual job.

  `toBedrockToolConfig` and `buildLimitedSpawn` are exported so the mapping and the spawn shape can be asserted directly rather than through a live process.

### Minor Changes

- 935b8f3: Prompt caching is now requested, not just measured.

  The driver read the cache-hit and cache-write counters off every response
  and never asked for caching, so both were permanently zero: the entire
  static prefix — tool schemas, system instructions, the whole conversation
  so far — was re-sent and re-billed at full rate on every single turn of
  every run. Nothing failed, which is why it went unnoticed; it was purely
  money and latency.

  A breakpoint on this wire is a content BLOCK rather than an annotation on a
  neighbouring one: everything ahead of it in render order is cached. Render
  order is tools → system → messages, so the driver places one at the tail of
  each section, and each later breakpoint covers everything before it:

  - after the tool schemas, which render first and are the largest static
    segment — this keeps them cached even when the conversation below changes
    every turn;
  - after the last system block the runtime tagged as static, NOT at the end
    of the system section. The per-run dynamic tail comes after that tag; a
    breakpoint over text that changes every run invalidates the entry each
    turn and bills a cache write for nothing;
  - after the last message, so the next iteration — which only appends —
    reads all the prior history at cache rates.

  Three breakpoints, one under the wire's limit of four. None are placed
  unless the caller sets `cacheControl`, and none are placed over system
  text with nothing static in it or on a message with no content.

- 935b8f3: Every driver can now see.

  These three dropped `attachments` outright, so a user who attached a
  screenshot got a turn about nothing. `supportsVision: false` said so, which
  made the declaration honest and the driver useless — and it was the last
  place in the estate where a namzu capability existed on one driver and
  silently did not on another.

  Each wire carries an image differently, so this is one intent and three
  mappings:

  - **Converse**: raw bytes in an image content block beside the text. The
    tool-result path already did this; the user path never looked at
    `attachments`.
  - **The two-dialect HTTP driver**: a `data:` URI content part on one
    dialect, a base64 source block on the other.
  - **The gateway driver**: a `data:` URI content part.

  Across all three: a media type the endpoint cannot decode is named in the
  text rather than sent, because a payload it rejects fails the whole request
  and losing the turn is worse than losing sight of one image. A message with
  no attachments keeps its plain-string content, so nothing about an ordinary
  request changes shape. Several attachments on one message are carried in
  order.

  An image inside a **tool result** still degrades to a text placeholder on
  the HTTP and gateway drivers: a tool message is text-only in those dialects,
  so there is nowhere to put it. Converse carries it, and always did.

### Patch Changes

- 935b8f3: The conversation cache anchor advances, so the next request can read it.

  A single breakpoint at the conversation tail writes a new cache entry every
  turn and reads none of them: by the next request the tail has moved, so the
  marker sits somewhere the previous entry does not cover. The tools and
  system tiers keep hitting through their own breakpoints — which is exactly
  what made this invisible. Only the messages tier silently re-billed as a
  write.

  Both drivers now place a second anchor one turn back, which is where the
  previous request put its tail marker and therefore the prefix that is
  already cached.

  It matters most where the history grows fastest. Pending tool results
  collapse into a single message, so a fan-out of ten parallel calls appends
  twenty content blocks in one turn — far enough to push the prior boundary
  out of reach of a backward scan that stops at the first non-empty message.

  This spends the fourth of the four allowed breakpoints, previously
  documented as deliberately unspent. It is spent on the one tier that was
  never hitting. A conversation with a single message still gets one anchor,
  because there is nowhere behind it to put a second.

- 935b8f3: Retry now works on the bedrock driver, and the shared classifier reads a
  status wherever a vendor hides it.

  An unclassified error is treated as non-retryable, which is the right
  default — but it meant the retry policy was effectively dead on this
  driver, and the one failure most worth backing off from was the one that
  killed the run. The service reports failures as named exception classes,
  and the classifier looked at neither the name nor the status, because the
  status lives in a metadata bag rather than on the error.

  - `classifyProviderError` now also reads `$metadata.httpStatusCode`. A
    status is a status wherever it hides, and this helps any driver — first
    or third party — whose SDK reports it that way.
  - The bedrock driver maps its own exception vocabulary to provider error
    codes: throttling and quota to `rate_limit`, unavailable and not-ready to
    `overloaded`, internal and stream faults to `server_error`, and the
    non-retryable ones (`ValidationException`, `AccessDeniedException`,
    `ResourceNotFoundException`) to their exact codes so they fail fast
    instead of burning the retry budget.

  The vocabulary lives in the driver rather than the shared classifier: a
  driver knows its own vendor's error names, and the classifier should stay
  generic. An unrecognised exception passes through untouched — an honest
  unknown beats a confident wrong classification.

- 935b8f3: Lift the dependency floor to versions without published advisories

  Eighty-two open advisories collapsed to a handful of real decisions, because most of them were the same package reached through one path.

  The telemetry exporters carried a serialization library with twenty-four advisories against it, two of them critical. The exporters move from the 0.57 line to 0.221, and the stable packages beside them from 1.x to 2.x — a major bump for this package, since a consumer pinning the older peers must move with it.

  The two vendor driver SDKs move to their current releases, closing the advisories that came with them.

  The test runner accounted for fourteen critical advisories on its own. It is a development dependency and never reaches a published artifact, but it runs in CI against the repository's own contents, so it moves to the first patched release rather than being waved through as out-of-scope.

- 935b8f3: Stop dropping tool-failure status on Bedrock, and stop accepting a sandbox
  egress policy this backend cannot enforce.

  - **Bedrock** flattened every failed tool result into an ordinary success.
    The executor computed `isError`, the SSE and A2A bridges carried it, and
    the driver dropped it — even though Converse has a first-class
    `toolResult.status`. The model's trained tool-failure recovery path keys
    off that field, so namzu was relying on prose formatting to convey "that
    call failed".

    Scope note: the five OpenAI-shaped drivers are NOT affected, because
    Chat Completions has no error field on a tool message at all. The error
    reaches those models inside the result text, which is the only channel
    the protocol has.

  - **Docker sandbox** accepted `EgressPolicy` and silently ignored it. A
    host that set `deny-all` believed the container had no network and it had
    whatever `network` was configured. A security control that is accepted
    and ignored is worse than one that does not exist. Now: `deny-all` maps
    to `--network none` (which Docker enforces natively), `allow-all` keeps
    the configured network, and `static` / `resolver` **throw** — this
    backend has no proxy to filter hosts through, and downgrading a
    restrictive policy to "allow everything" is exactly the failure worth
    refusing.

  - **Docker sandbox** containers now run with `--cap-drop=ALL` and
    `--security-opt=no-new-privileges`, plus an opt-in `runAsUser`.
    `CAP_DAC_OVERRIDE` alone walks past the read-only bind mounts the layout
    sets up, and without `no-new-privileges` a setuid binary in the image
    re-escalates.

- 935b8f3: Stop dumping a tool result's base64 payload into the prompt.

  Four drivers mishandled a tool result carrying content blocks, each in its
  own way: bedrock and the http driver's anthropic dialect `JSON.stringify`d
  the whole array, putting a screenshot's base64 into the prompt as JSON
  text; openrouter and the http driver's openai dialect passed the array
  through raw to an endpoint expecting a string; lmstudio folded it into a
  template literal, producing `[object Object]` per block. The model cannot
  decode any of it, and it costs a fortune in tokens.

  - The three text-only wires now flatten with the SDK's existing helper,
    which names a non-text block and its size instead of inlining it. The
    openai and ollama drivers already did this — the helper was there and
    four callers were missing.
  - **bedrock sends the image as an image.** That wire carries images
    natively, so a placeholder would be a downgrade the other drivers accept
    only because their format has no room for one. Text and image survive as
    separate blocks in order, and a media type the format does not accept
    still degrades to a named placeholder rather than being smuggled through
    as text.

- 935b8f3: Four drivers dumped tool-result payloads into the prompt, and one ignored the strict-schema hint.

  **A tool result carrying an image was `JSON.stringify`d** on four drivers, so a screenshot reached the model as a wall of quoted base64. The model paid for every character, could read none of them, and — worse — saw a serialized object where a picture should be, with nothing saying anything had been withheld. The SDK's `toolResultToText` exists for exactly this and produces a named placeholder reporting the media type and the size. All four now use it: `@namzu/bedrock`, both dialects of `@namzu/http`, and `@namzu/lmstudio`.

  **`enforceToolInputSchema` was ignored by `@namzu/openai`.** It names the tools whose model-facing schema should be enforced by constrained generation rather than merely suggested; both sibling drivers consumed it. A caller who had asked for a guaranteed-valid tool input silently got a best-effort one and learned about it from a repair attempt. This is the wire the flag maps onto most directly — it takes the flag on the function itself. The existing test asserting the tools went through untouched read as "the hint is kept out of the request" and actually pinned "the hint does nothing"; it now asserts the hint is consumed and still never appears verbatim.

  **An extended-thinking request is refused by `@namzu/openai` rather than dropped.** The parameter was accepted and ignored, so a caller who asked for reasoning got an ordinary completion with an empty reasoning list — which reads as "the model did not reason" rather than "nobody asked it to". Turning thinking off stays a no-op, since that is the state the driver is already in.

  Eleven previously empty test files now cover these drivers, including the capability claims themselves: every driver that declares no vision, documents or tools is pinned against drift in both directions, because the runtime warns or fails on those flags before a request is built, and a flag flipped ahead of its mapping is as wrong as a mapping written without the flag.

- 935b8f3: Overflow reaches the rescue that exists for it.

  Overflow is the one 4xx the runtime can act on: it sheds history and
  retries. Everything else in the 400 family is surfaced. So the rescue is
  gated on the code being **exactly** `context_length_exceeded`, and anything
  that misses that gate dies holding the remedy.

  Three things missed it. Measured before and after, five of six realistic
  overflow shapes never reached relief; now all six do.

  - **The structural code was extracted and then discarded.** The cause-chain
    walk returned the first `code` it found and fed it only to the two
    transport-errno sets, so a provider that said `context_length_exceeded` in
    the one field designed to say it was answered with a substring search that
    did not match. A structural code is now consulted **before** the status,
    because it is strictly more specific: a 400 is a category, the code is the
    diagnosis. The gateway `type` discriminator and a nested error envelope
    are read the same way.
  - **The phrase list missed the common wordings.** "too long for", "maximum
    length", "exceeds the maximum", "input is too large" all fell through to a
    plain non-retryable invalid request.
  - **The Converse driver pre-filed `ValidationException` as
    `invalid_request`.** That name covers both a malformed request and a
    prompt past the model's window, and only one of those is recoverable — so
    guessing from the name made the recoverable case unrecoverable by
    construction, because the shared classifier short-circuits on an error
    that already carries a code and never read the body. It now hands that one
    name to the classifier. The result is still a `ProviderError`, so the
    driver's contract is unchanged; it just stops answering a question it
    cannot answer from the name alone.

  The rate-limit half of the same class is fixed alongside: a provider that
  reports `rate_limit_exceeded` structurally under a 400 is now retryable
  instead of being filed as a bad request.

- 935b8f3: A user message can carry a document

  Documents existed in the type system only in the tool-result direction, and both first-party drivers mapped images only on the input side. So "here is the contract, answer questions about it" — a mainstream workload — was reachable only by having a tool read the file and stringify it. That loses the provider's native document handling (page structure, built-in OCR, citations) and pays the text cost instead.

  `UserMessage.attachments` is now `MessageAttachment[]`: an image or a document. The discriminant is optional and stays optional — an attachment without one is an image, which is what every attachment was before, so no existing caller changes.

  `supportsDocuments` sits beside `supportsVision` in the driver capability declaration, and the runtime checks it the same way: a document sent to a driver that declares `false` warns before the request, or throws under `strictCapabilities`, instead of letting the model answer about a file it never saw. The two are counted separately because they are separate wire shapes and a driver can map one without the other.

  The two first-party drivers map documents natively. The remaining five map images only and now say so; a document reaching them degrades to a named placeholder that says which kind was dropped, rather than one that calls a document an image.

## 1.0.3

### Patch Changes

- 3fd2524: Normalize request-start and mid-stream failures across all seven provider
  drivers with the new public `ProviderRequestError` taxonomy. Errors expose
  `kind` (`throttle`, `network`, `auth`, `context_overflow`, `bad_request`, or
  `server`), `providerId`, and optional `status` / `retryAfterMs`, with
  `isProviderRequestError` available for structural narrowing across package
  copies.

  Provider error messages and metadata deliberately omit vendor response bodies,
  URLs, messages, and causes because upstream errors can echo credentials. HTTP
  dialect-mismatch diagnostics now keep only the endpoint origin and status.
  Caller-owned aborts remain unchanged instead of being reclassified.

  The runtime preserves the classified error through streaming and publishes its
  safe metadata as `Run.lastProviderError` and
  `run_failed.providerError`. Bedrock stream-exception events and provider
  iterator/SSE failures no longer appear as clean end-of-stream.

  `retryAfterMs` is metadata only; this change does not add retries or alter vendor
  SDK retry settings. Provider packages now require `@namzu/sdk >=1.3.0`, the
  first SDK release containing these runtime helpers and types.

  Ollama now maps `done_reason: "length"` truthfully so runtime continuation can
  run. LM Studio treats content-free `contextLengthReached` as context overflow,
  while preserving `"length"` after partial content, and creates its WebSocket
  client lazily on first use.

## 1.0.2

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

## 1.0.1

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

### Patch Changes

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

All notable changes to `@namzu/bedrock` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-15

### Added

- Initial release. BedrockProvider extracted from @namzu/sdk core per ADR-0001.
- Converse API (chat + chatStream) with tool-use support.
- `registerBedrock()` helper for one-call provider registration.
- Module augmentation of @namzu/sdk's ProviderConfigRegistry for type-safe config.

### Changed

- Observability (OTEL spans, structured logging) removed pending @namzu/telemetry package.
