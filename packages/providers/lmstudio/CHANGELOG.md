# Changelog

## 2.1.1

### Patch Changes

- 36248f3: Add separate provider capability declarations for image and document tool
  results, and warn immediately before a request would degrade newly produced
  rich tool output. Tool presenters can now mark a generic label as a complete
  activity and mark a redundant successful acknowledgement as hidden; older
  hosts continue to render the same generic label.

  The account-routed Responses transport now sends supported user images and
  image tool results as ordered image input parts. Documents, unresolved stored
  references, unsupported image media types and unprojected omission markers are
  refused before transport.

  The interactive transcript now follows the visible conversation tail without
  a synthetic viewport-height gap, responds to terminal resize, narrates desktop
  actions with human labels, hides only successful empty acknowledgements, and
  keeps screenshot dimensions and failures visible.

## 2.1.0

### Minor Changes

- 03e363c: Declare the Node floor these packages already had, and export a type `TelemetryConfig` already required.

  **`engines.node: ">=20.0.0"`.** Only `@namzu/cli` declared one; the other fourteen published without any, so npm could not warn a consumer installing onto an unsupported runtime — they got a crash at some later import instead. The floor is not new: `@namzu/cli` has declared it since it shipped and `install.sh` has enforced it since it existed. This makes the other fourteen say the same thing.

  If you install with `engine-strict=true` on Node 18, an install that previously emitted nothing will now fail. Upgrade to Node 20 or newer, which the code already assumed. Everyone else sees no change, or an `EBADENGINE` warning that replaces a later crash.

  Worth stating plainly: CI verifies Node 22 and 24. The 20 floor is a declared minimum, not a tested one.

  **`SpanProcessorLike` is now exported from `@namzu/telemetry`.** `TelemetryConfig.spanProcessors` takes `readonly SpanProcessorLike[]`, and the type had no export — a field on the public surface whose type was not on it, so a host supplying the value had to inline the shape or reach for `any`.

## 2.0.2

### Patch Changes

- 5394981: Make each driver's README an npm package page rather than its manual.

  Every driver README carried its full reference — configuration tables, capability matrices, error surfaces — between 167 and 392 lines of it. That is a reasonable shape for a single-package repository, where the README _is_ the documentation, and the wrong one for a package in a monorepo that has a `docs/` tree: it duplicates what the docs say, and nothing checks that the two agree.

  The README is now what a reader needs in the first minute — what the driver is, install, one working example, links. The reference moved to `docs/providers/<name>.md`, whole, and its code samples are now compiled against the built SDK by the doc-fence gate on every CI run. They never were before; several did not compile.

  No API change.

## 2.0.1

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

## 2.0.0

### Major Changes

- 1500973: Every driver that cannot think now says so instead of dropping the request.

  `thinking` sits on `ChatCompletionParams`, so every driver accepts it. Five of
  them — Bedrock, OpenRouter, HTTP, Ollama, LM Studio — implemented none of it
  and dropped the field: the caller got an ordinary completion with an empty
  `reasoning` array, which is indistinguishable from a model that simply chose
  not to reason. The request looked honoured and the answer looked like an
  answer.

  The OpenAI driver already refused instead, with the reasoning written out
  beside it. So the rule had been decided once and applied once, while five
  siblings went on being silent. It moves to `@namzu/sdk` as
  `assertThinkingUnsupported(driverName, params)`, and a new driver now inherits
  it rather than re-deciding it.

  The error names the driver, which in a multi-provider setup is the difference
  between a bug report about the model and a one-line configuration fix.

  **Turning thinking off stays a no-op** on all of them, because that is the
  state a driver without thinking is already in — a config shared across
  providers saying `{ type: 'disabled' }` should not fail on the ones that were
  never going to think.

  `assertThinkingSupported` in `@namzu/openai` is unchanged as an export and now
  delegates to the shared helper. Its message changed: it no longer says
  "extended thinking", because `adaptive` is refused too and calling that
  extended would be wrong.

  **Migration.** If you passed `thinking` to any of the five and relied on it
  being ignored, remove it — you were receiving a non-thinking answer either way,
  and now you find out at the call instead of by inspecting an empty array.

  Not in this change: implementing thinking natively on Bedrock, which serves the
  same Claude models through a different wire and deserves the per-model
  resolution the Anthropic driver just gained. That needs the Converse request
  and response shapes verified against the reference first, and is not something
  to guess at.

## 1.2.0

### Minor Changes

- 05b4103: Two timeouts that did nothing, and a recursion limit that was not the one in force.

  **`OllamaConfig.timeout` and `LMStudioConfig.timeout`** were declared with no doc comment and read by nothing — both constructors forwarded the host and the model and never looked at them, so a host that set a timeout waited forever anyway. The wait they exist for is specific to a local server: the process is up, the socket accepts, and the model never answers because it is still loading or the machine is out of memory.

  Both are composed with the caller's cancellation rather than replacing it. The caller's signal is how a run stops mid-generation, and dropping it for a deadline would leave a local model generating after the run that asked for it has stopped. Absent means no deadline, exactly as before.

  The deadline covers the whole request rather than the time to the first byte, because the failure it exists for is a server that accepts and then never finishes — bounding only the head leaves precisely that case unbounded. A zero or negative value is refused at construction, since it would abort every request rather than bound it.

  **`SupervisorAgentConfig.maxDepth` is deprecated** and documented as not consulted. The recursion bound is enforced in `AgentManager.sendMessage` against the manager's own config, and a supervisor receives a manager rather than building one — so a host setting it on the supervisor got the manager's value regardless. For a safety limit that is the worst way to be wrong: the number in front of the reviewer is not the number in force. Set it on `AgentManagerConfig`, where it is read. Tests now pin both halves, so a change that starts consulting the supervisor's copy fails rather than shipping quietly.

## 1.1.0

### Minor Changes

- 935b8f3: Images reach the model.

  `attachments` were dropped outright, so a user who attached a screenshot got
  a turn about nothing. `supportsVision: false` said as much, which made it
  honest and still useless.

  An image cannot be inlined on this wire — it is uploaded to the backend and
  the message references the handle that comes back. That makes the mapping
  asynchronous, so the upload happens ahead of it and the message mapping
  stays a pure function of what it is handed.

  - A media type the backend cannot decode is named in the text rather than
    uploaded and found undecodable half a turn later.
  - An upload that fails leaves a note saying the image could not be sent,
    and the turn continues. Losing sight of one image is recoverable; the run
    dying over it is not — and "there was an image you cannot see" is a
    different situation from there having been no image, so the model is told
    which one it is.
  - Several attachments on one message are carried in order.

  An image inside a **tool result** stays a text placeholder. A tool message
  on this wire may hold result parts and nothing else, so there is nowhere to
  reference a handle from; moving it into a separate user turn would put words
  in the user's mouth to make a picture fit.

- 935b8f3: Both local drivers now speak tools, and say so.

  Each declared `supportsTools: false` and meant it: neither read `params.tools`,
  so no schema ever reached the model and the runtime stripped the tool surface
  before every run. The declaration was honest, which is why nothing broke
  loudly — it was simply a capability neither driver had, on wires that have
  carried tools all along.

  **Both drivers**

  - Tool schemas are sent, calls are surfaced with an id, a name and JSON
    arguments, and each call closes as it arrives rather than at end-of-stream —
    so a first call can start executing while a second is still being generated.
  - The assistant turn that made a call is replayed as a call, not as prose. It
    used to be dropped, which left the model reading an answer to a question it
    had no record of asking.
  - The finish reason is `tool_calls` when a call was made.

  **Local daemon driver**

  - A tool result is bound to its call by tool NAME on that wire, not by call id;
    the name is resolved from the assistant turn that made the call.
  - Image attachments are carried as image bytes instead of a text placeholder,
    and an image inside a tool result is carried too. A media type the daemon
    cannot decode would fail the whole request, so an unrecognised format is
    named in the text rather than sent as bytes.
  - Reasoning is requested only when the caller asks for it, streamed as
    reasoning rather than answer text, and replayed back on the next turn.
  - `supportsTools`, `supportsFunctionCalling` and `supportsVision` are now
    `true`.

  **Local desktop driver**

  - The conversation is mapped onto the backend's native part structure: the
    assistant's calls and each result are first-class parts, replacing the
    `[tool-result]` marker that folded results into a user turn.
  - Tool names round-trip untouched. The backend rewrites them by default, and
    since the runtime owns the loop nothing maps a rewritten name back — a
    rewritten name would come home unresolvable.
  - Arguments are taken from the backend's parsed object rather than stitched
    from raw fragments, which the backend warns are not guaranteed to be JSON.
  - A call that fails to parse is reported rather than swallowed: silence there
    is indistinguishable from a model that chose not to call anything.
  - Reasoning fragments are routed to reasoning, and the `<think>` tags
    themselves stay out of the answer.
  - New `client` config option: pass an already-connected backend client instead
    of dialing a new one. The underlying SDK opens its websocket in the
    constructor, so several providers against one server would otherwise open a
    connection each with no handle on their lifetime.
  - `supportsTools` and `supportsFunctionCalling` are now `true`. `supportsVision`
    stays `false` — an image would have to be uploaded and referenced by handle
    first, and this driver does not make that round-trip.

### Patch Changes

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

All notable changes to `@namzu/lmstudio` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-15

### Added

- Initial release. LM Studio support via the official `@lmstudio/sdk` client.
- `LMStudioProvider` implements `LLMProvider` (chat + chatStream).
- `registerLMStudio()` helper for one-call provider registration.
- Module augmentation of @namzu/sdk's ProviderConfigRegistry for type-safe config.
- Default host: `http://localhost:1234` (or LMSTUDIO_HOST env var).

### Changed

- Observability (OTEL spans, structured logging) excluded pending @namzu/telemetry package.
