# Changelog

## 1.1.1

### Patch Changes

- 48d9d67: Published tarballs no longer contain test files.

  `files: ["dist", "src", ...]` reads as "the build output and the sources" and
  means "everything the compiler emitted and everything in the tree", so every
  compiled test, its declaration, and both source maps shipped to the registry —
  and for the twelve packages that also ship `src`, the raw test sources went with
  them.

  Measured on the versions currently published:

  | package      | files       | of which tests | unpacked           |
  | ------------ | ----------- | -------------- | ------------------ |
  | `@namzu/sdk` | 3879 → 2239 | 1640 (42%)     | 12.73 MB → 6.81 MB |
  | `@namzu/cli` | 462 → 282   | 180 (39%)      | 1.21 MB → 0.73 MB  |

  Nothing you can import changes. Every package restricts `exports` to `"."`, so
  Node refused a deep subpath into those files already — they were weight in the
  tarball and nothing else. Hence `patch`: there is no consumer-visible surface
  here, only less to download.

  The exclusions are at the packaging layer, not the compiler. Adding `exclude`
  to `tsconfig.json` would have kept tests out of `dist` and also dropped them
  from `tsc --noEmit`, silently ending type-checking of the entire test suite —
  trading a packaging defect for a much worse one.

## 1.1.0

### Minor Changes

- 935b8f3: Documents and citations were designed in the SDK and never built in the drivers.

  `DocumentAttachment` and `Citation` existed in `@namzu/sdk` with a page of documentation about why native document handling is worth having — page structure, the provider's own extraction, and the ability to say which passage an answer rests on. The stream chunk carried a citation slot, the run's stream aggregator collected them onto the assistant message, and the iteration attached them to the turn. Both these drivers declared `supportsDocuments: true`.

  Neither had a document branch. Every attachment was mapped as an image — a PDF went up as an image block with `media_type: application/pdf` on one wire and as `data:application/pdf;base64,…` inside an `image_url` part on the other, shapes the APIs reject. And only the mock provider ever emitted a citation, so in a real run the slot was always empty: an answer about a contract arrived as prose, and checking it meant reading the contract again.

  - **`@namzu/anthropic`** now sends a native document block carrying the media type, the optional title, and — only when the attachment asked for them, because they cost tokens — citations. It parses citation deltas back onto the stream, keeping the location as the discriminated union the SDK defines: a provider that segments by character offset has no page number, and a citation whose location cannot be named is dropped rather than given an invented one. A citation that looks checkable and is not is worse than none.
  - **`@namzu/openai`** now sends a document as a `file` content part with its filename. That wire has no way to return citations, so a document that asks for them is refused with a message naming the document and what to do instead — answering without them would drop the checkability the caller asked for, and an empty citation list reads as "the model cited nothing" rather than "nobody asked".

  The drivers that declare `supportsDocuments: false` were already honest: none of them map attachments at all, and the runtime warns (or fails under `strictCapabilities`) before the request is built.

- 935b8f3: Four drivers dumped tool-result payloads into the prompt, and one ignored the strict-schema hint.

  **A tool result carrying an image was `JSON.stringify`d** on four drivers, so a screenshot reached the model as a wall of quoted base64. The model paid for every character, could read none of them, and — worse — saw a serialized object where a picture should be, with nothing saying anything had been withheld. The SDK's `toolResultToText` exists for exactly this and produces a named placeholder reporting the media type and the size. All four now use it: `@namzu/bedrock`, both dialects of `@namzu/http`, and `@namzu/lmstudio`.

  **`enforceToolInputSchema` was ignored by `@namzu/openai`.** It names the tools whose model-facing schema should be enforced by constrained generation rather than merely suggested; both sibling drivers consumed it. A caller who had asked for a guaranteed-valid tool input silently got a best-effort one and learned about it from a repair attempt. This is the wire the flag maps onto most directly — it takes the flag on the function itself. The existing test asserting the tools went through untouched read as "the hint is kept out of the request" and actually pinned "the hint does nothing"; it now asserts the hint is consumed and still never appears verbatim.

  **An extended-thinking request is refused by `@namzu/openai` rather than dropped.** The parameter was accepted and ignored, so a caller who asked for reasoning got an ordinary completion with an empty reasoning list — which reads as "the model did not reason" rather than "nobody asked it to". Turning thinking off stays a no-op, since that is the state the driver is already in.

  Eleven previously empty test files now cover these drivers, including the capability claims themselves: every driver that declares no vision, documents or tools is pinned against drift in both directions, because the runtime warns or fails on those flags before a request is built, and a flag flipped ahead of its mapping is as wrong as a mapping written without the flag.

- 935b8f3: Tool arguments can be made valid by construction

  namzu has a whole repair path for arguments that do not match a tool's schema — a repair hook, a bounded retry, a model-visible error. This wire format offers a mode where the endpoint constrains decoding to the schema, so invalid arguments cannot be emitted at all, which is strictly better than repairing them well.

  `strictTools: true` turns it on. Off by default because it is a real trade: strict decoding requires every property to be required, so the driver rewrites each schema — objects close, every property joins `required`, and one that was optional widens to accept `null` so "leave it out" stays expressible. An optional argument therefore becomes one the model must pass explicitly as null, and that change to what the model is told belongs to the tool's author rather than the driver.

  The rewrite is not separable from the flag: the endpoint rejects strict mode on a schema that has not been closed for it, so sending one without the other would turn a correctness feature into a 400.

- 935b8f3: A user message can carry a document

  Documents existed in the type system only in the tool-result direction, and both first-party drivers mapped images only on the input side. So "here is the contract, answer questions about it" — a mainstream workload — was reachable only by having a tool read the file and stringify it. That loses the provider's native document handling (page structure, built-in OCR, citations) and pays the text cost instead.

  `UserMessage.attachments` is now `MessageAttachment[]`: an image or a document. The discriminant is optional and stays optional — an attachment without one is an image, which is what every attachment was before, so no existing caller changes.

  `supportsDocuments` sits beside `supportsVision` in the driver capability declaration, and the runtime checks it the same way: a document sent to a driver that declares `false` warns before the request, or throws under `strictCapabilities`, instead of letting the model answer about a file it never saw. The two are counted separately because they are separate wire shapes and a driver can map one without the other.

  The two first-party drivers map documents natively. The remaining five map images only and now say so; a document reaching them degrades to a named placeholder that says which kind was dropped, rather than one that calls a document an image.

### Patch Changes

- 935b8f3: Three driver defects found by auditing every provider against the same
  contract checklist rather than one at a time.

  **anthropic — a thinking block never reported its close.** `openReasoning`
  was declared, read by the `content_block_stop` branch, and never added to:
  three references in the whole file. The set was permanently empty, so the
  close branch could not match and `reasoning: { done: true }` never reached
  the consumer. A host that opens a thinking card on the first reasoning
  delta left it spinning for the rest of the run. Stored blocks were
  unaffected, so replay always looked correct — only the live stream was
  broken, which is why it survived. This is the default driver.

  **openai — every request to a reasoning-family model failed on turn one.**
  `temperature` and `max_tokens` were sent unconditionally, and those models
  reject both, requiring `max_completion_tokens`. The rejection is a 400,
  which classifies as `invalid_request` and is not retryable, so the run
  died immediately whenever a token cap was set — which the runtime always
  does. Model family is now detected by id prefix, conservatively: an
  unknown model keeps the standard parameters, because a false positive
  silently strips `temperature` from a model that honours it while a false
  negative produces a clear error naming the parameter.

  **http — every streamed turn reported zero tokens.** The body builder never
  requested usage on a streamed response, so a conforming endpoint sent none
  and the (complete) parsing had nothing to parse. Cost read as free, and any
  budget or compaction threshold keyed on usage never fired however large the
  thread grew.

- 935b8f3: Widen the message model to content blocks: multimodal tool results, `is_error`,
  and reasoning replay.

  `ToolMessage.content` was `string` and `AssistantMessage` had no slot for
  reasoning, so three separate things died at the provider boundary. Doing them
  as one migration is deliberate — all three need the same widening, and every
  stored transcript, checkpoint and `messages.json` is written in the narrow
  shape, so the cost only grows.

  **Tool results can carry non-text content.** `ToolResultContent` is
  `string | ToolResultBlock[]`, where a block is text, image or document. String
  stays first-class: the common case is unchanged and every existing tool and
  driver compiles untouched. `@namzu/computer-use`'s `screenshot` returned
  ~400 KB–2.7 MB of base64 **as text** — roughly 100k–670k tokens of characters
  no model can decode — so computer use was effectively non-functional; it now
  returns an image block with a short textual description. MCP `image` and
  inline `resource` blocks are passed through instead of being filtered out.

  **Failures are marked on the wire.** The executor computed `isError`, routed it
  to the SSE bridge, the A2A bridge and the TUI, then dropped it at the provider
  boundary — so the model's trained tool-failure recovery never fired. The
  Anthropic driver now sends `is_error: true`, and the value survives the
  executor's result tuple, which previously narrowed to `{toolCallId, output}`
  before the message was built.

  **Reasoning is representable and replayed verbatim.** `AssistantMessage.reasoning`
  holds opaque `ReasoningBlock`s (thinking / redacted, with signature or encrypted
  payload). The Anthropic driver used to rebuild every assistant turn as
  `[text?, ...tool_use]` — precisely the pattern the verbatim-echo contract
  prohibits when a `tool_result` follows — and now emits stored reasoning blocks
  first, signature intact.

  Drivers that cannot express non-text tool results (`@namzu/openai`,
  `@namzu/ollama`) degrade through `toolResultToText`, which renders an explicit
  `[image: …]` placeholder rather than dumping base64 or silently dropping it.

  This is the outbound half. The Anthropic driver does not yet parse thinking
  blocks out of the stream and `ChatCompletionParams` has no `thinking` field,
  so `reasoning` is populated only when a caller supplies it.

- 935b8f3: A turn that asked for tools no longer ends because the provider said it
  didn't.

  The iteration loop ended the turn on `finishReason === 'stop'` **before**
  looking at whether the model had asked for tools. Endpoints on the OpenAI
  wire shape — gateways and local servers especially — routinely report `stop`
  on the same response that carries a populated `tool_calls`, and three of
  this repo's drivers passed that value straight through.

  The damage was total and silent: every requested call skipped, an assistant
  turn left carrying `tool_use` blocks nothing ever answered, and the run
  settling as though it had finished the work it never started.

  - **The runtime now treats tool calls as the fact and the finish reason as
    the summary.** When they disagree, the calls win. This is the load-bearing
    fix: it protects every driver, including ones this repo does not ship.
  - **The three drivers that cast the reason raw now report it honestly** —
    a stream that produced a tool call reports `tool_calls`, whatever the
    endpoint called it. Defence in depth, and it makes the reported reason
    true for anyone else reading it.

  The existing suite could not catch this: the scripted mock reports
  `tool_calls` whenever it emits one, which is what an honest provider does
  and therefore never the case that breaks.

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

- f1f000c: Map user-message image attachments to OpenAI `image_url` content parts.

  `toOpenAIMessages` now converts `UserMessage.attachments` into
  multimodal content parts (text first, then each image as an
  `image_url` part carrying a `data:<mediaType>;base64,<data>` URI),
  mirroring the Anthropic driver's image-block mapping. Previously
  attachments were silently dropped. The driver declares
  `supportsVision: true` and exposes its capabilities on the provider
  instance for the SDK's capability negotiation.

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

All notable changes to `@namzu/openai` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-15

### Added

- Initial release. OpenAI support via the official `openai` npm SDK.
- `OpenAIProvider` implements `LLMProvider` (chat + chatStream).
- `registerOpenAI()` helper for one-call provider registration.
- Module augmentation of @namzu/sdk's ProviderConfigRegistry for type-safe config.
- Tool-use + function calling via Chat Completions API.

### Changed

- Observability (OTEL spans, structured logging) excluded pending @namzu/telemetry package.
