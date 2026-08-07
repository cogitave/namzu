# Changelog

## 4.0.1

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

## 4.0.0

### Major Changes

- f8355de: tool schemas are rendered in the dialect each wire actually parses

  A tool with a tuple-shaped field took down every request that offered it. The
  kernel renders one canonical JSON Schema in draft-07, where a tuple is
  `items: [a, b]`; one of the wires namzu speaks validates tool input as JSON
  Schema 2020-12, where that spelling is invalid and a tuple must be
  `prefixItems`. Every driver forwarded the rendering verbatim, so the built-in
  `read` tool — whose `readRange` is a Zod tuple — produced a 400 that rejected
  the **whole** request, taking every other tool in the call down with it. The
  turn died before generating a token.

  The failure had nothing to do with strict tool use, which is why the guard
  added for the previous schema outage never saw it: it fires with strict
  validation unset, and with strict on the dialect error arrives _first_.

  Which dialect a wire parses is a property of the wire, so the conversion now
  happens at each driver's boundary rather than in the renderer:

  ```ts
  import { toSchemaDialect, findDraft07Only } from "@namzu/sdk";

  toSchemaDialect(schema, "2020-12"); // items: [a, b]  ->  prefixItems: [a, b]
  findDraft07Only(schema); // paths that no 2020-12 parser will accept
  ```

  `renderToolSchema` is exported now too, so a caller assembling its own tool
  payload gets the same memoized, `$schema`-stripped, deep-frozen rendering the
  kernel puts on the wire — byte-identical across iterations, which matters
  because the tools block sits at position 0 of the prompt-cache prefix.

  `ToolCatalog` used to convert schemas through its own inline call with the same
  options. Same output, none of the guarantees: no `$schema` stripping, no
  memoization, no freeze. It goes through `renderToolSchema` now.

  **Breaking, for the three drivers.** Their `@namzu/sdk` peer range was
  `>=1.3.0` and is now `>=6.0.0`. That range was already wrong — the drivers call
  kernel functions added well after 1.3.0 — and it would now let a package
  manager install a combination that throws on every request carrying a tool.
  Upgrade the kernel alongside the driver.

  The conversion follows the model on multi-vendor wires. Bedrock's Converse API
  carries several vendors through one request shape, and the 2020-12 requirement
  was measured on one of them, so schemas bound for the others are left in the
  dialect they were rendered in. Guessing there would trade a known break for an
  unmeasured one.

## 3.0.1

### Patch Changes

- f25ebce: a model id's date suffix is no longer read as its minor version

  Three copies of one regular expression matched Claude model ids — the capability
  table plus two drivers — and all three had the same defect: the minor-version
  group was `(\d+)`, which swallowed the 8-digit date suffix.

  Measured against the shipped pattern:

  ```
  claude-sonnet-4-20250514   ->  major=4  minor=20250514
  claude-opus-4-1-20250805   ->  major=4  minor=1
  ```

  So a dated id naming no minor version compared as enormously _newer_ than one
  that does, and every capability gate keyed on `minor >= n` inverted for exactly
  those ids. `claude-sonnet-4-20250514` was classified as a 4.7+ model: the driver
  sent it `thinking: {type: 'adaptive'}`, silently discarding a caller's
  `budgetTokens`, and cleared the 4.5 gate that enables strict tool inputs.

  `parseClaudeModelVersion` and `claudeVersionAtLeast` are now exported from
  `@namzu/sdk` and used by both drivers and the capability table. A real minor
  version is one to three digits; a date is eight, and the group is bounded
  accordingly. An id the parser does not recognise makes `claudeVersionAtLeast`
  return `false` — a capability gate must not open for a name it does not
  understand.

  The comment above the old parser warned that "a second, subtly different model
  matcher is how two capability decisions drift apart on the same model name."
  There were three.

- 61ca851: a tool whose schema cannot carry the guarantee it asks for is refused at registration

  The previous release fixed the `edit` tool's schema and added a check in the
  Anthropic driver. That caught the bug, but in the wrong place: per request, in
  one of the **two** drivers that mark tools strict, and only once something
  actually ran.

  `ToolRegistry` already refused `enforceModelInput` without a
  `modelInputSchema`, and the comment above that check states the principle
  exactly — _"Refusing at registration puts the error where the author can fix it
  rather than at the first request."_ The rule was written down; the new check was
  somewhere else.

  It is now beside its sibling. One asks whether a model schema **exists**; the
  other asks whether it can **carry the guarantee the tool just requested**. A
  tool that asks for constrained generation and supplies a schema the constrained
  dialect cannot express is wrong at the moment it is declared, whichever model it
  later meets — so it never registers, and can never reach a request.

  ```
  Tool "edit" is marked for strict input validation, but its model-facing schema
  uses 1 construct(s) the strict subset does not accept…
    edit.properties.insertLine.oneOf — use `anyOf` — for disjoint branches the two are equivalent
  ```

  This is the only path that matters in practice: the kernel builds its tool list
  with `ToolRegistry.toLLMTools()`, so every tool reaching a driver through the
  normal loop passed the gate.

  **A tool that never asked for the guarantee is untouched.** Without
  `enforceModelInput` nothing is marked strict, the schema is sent as ordinary
  JSON Schema, and `oneOf` is perfectly legal there. Refusing it would break
  working setups for no reason.

  `@namzu/http` also marks tools strict and had no check at all — the same bug
  was reachable through it. It now has the driver-level check the Anthropic driver
  already carried. Both remain as a second boundary for a host that hand-builds
  `ChatCompletionParams` and calls a provider directly, bypassing the registry.

  **If you author a tool with `enforceModelInput: true`,** a schema using `oneOf`,
  `not`, `if`/`then`/`else`, numeric or length bounds, `patternProperties`, or an
  `additionalProperties` other than `false` now throws at registration instead of
  failing the first request that carries it. The message names the path and the
  replacement.

## 3.0.0

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

## 2.0.0

### Major Changes

- 935b8f3: Three controls a caller could set that the runtime then quietly declined to apply.

  - **`toolChoice: 'none'` permitted tool calls on two drivers.** It means the model must not call a tool. One driver mapped it to the wire's "auto" and the other to `{ type: 'auto' }` — both of which say the model _may_. A caller that had forbidden tool use got a request that allowed it, with nothing in the response to say so. The runtime depends on the guarantee: an advisory consultation passes `'none'` so the advisor answers in prose, into a turn where no executor is waiting for a tool call. Both drivers now answer `'none'` by sending no tools at all, which no wire format can misread.

  - **`memoryLimitMb` and `maxProcesses` were dropped by the stronger isolation tiers.** They were applied inside the unconfined tier's branch only, so asking for namespace or profile isolation silently removed the blast-radius caps — a control failing in the one direction nobody checks. They are the same shell builtin on every tier; the stronger tiers now apply them one level in, inside the wrapper they already spawn through, and keep doing their own job. The sibling backend in the sandbox package already refuses per-sandbox controls it cannot enforce rather than ignoring them; this is the same rule, satisfied by enforcing.

  - **`AgentManager.dispose()` cancelled nothing.** It called `cancelAll('' as RunId)`, and `cancelAll` filters by parent run — no task has an empty parent, so it matched nothing, and the next lines cleared the instance map. Every live child was released without its abort controller firing: the work kept running, the budget kept draining, and nothing was left holding a reference to stop it. It now cancels every live child before dropping them. `cancelAll` stays scoped to one parent, which is its actual job.

  `toBedrockToolConfig` and `buildLimitedSpawn` are exported so the mapping and the spawn shape can be asserted directly rather than through a live process.

### Minor Changes

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

- 935b8f3: A user message can carry a document

  Documents existed in the type system only in the tool-result direction, and both first-party drivers mapped images only on the input side. So "here is the contract, answer questions about it" — a mainstream workload — was reachable only by having a tool read the file and stringify it. That loses the provider's native document handling (page structure, built-in OCR, citations) and pays the text cost instead.

  `UserMessage.attachments` is now `MessageAttachment[]`: an image or a document. The discriminant is optional and stays optional — an attachment without one is an image, which is what every attachment was before, so no existing caller changes.

  `supportsDocuments` sits beside `supportsVision` in the driver capability declaration, and the runtime checks it the same way: a document sent to a driver that declares `false` warns before the request, or throws under `strictCapabilities`, instead of letting the model answer about a file it never saw. The two are counted separately because they are separate wire shapes and a driver can map one without the other.

  The two first-party drivers map documents natively. The remaining five map images only and now say so; a document reaching them degrades to a named placeholder that says which kind was dropped, rather than one that calls a document an image.

## 1.1.0

### Minor Changes

- 11167dd: Separate runtime tool validation from canonical model-facing JSON Schema,
  propagate constrained-input hints through the agent loop, and map reviewed
  schemas to Anthropic strict tool use with capability-aware overrides. The
  built-in edit tool advertises only canonical arguments.

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

All notable changes to `@namzu/http` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-15

### Added

- Initial release. Zero-dependency LLM provider for any OpenAI- or Anthropic-compatible HTTP endpoint.
- `HttpProvider` implements `LLMProvider` (chat + chatStream).
- `dialect` parameter: `'openai'` (default) for OpenAI-compat endpoints (Ollama, LM Studio, vLLM, Groq, etc.) or `'anthropic'` for native Anthropic Messages API.
- `registerHttp()` helper for one-call provider registration.
- Module augmentation of @namzu/sdk's ProviderConfigRegistry for type-safe config.
- `DialectMismatchError` thrown on response-shape mismatch (actionable error with URL + status + sample).

### Changed

- Observability (OTEL spans, structured logging) excluded pending @namzu/telemetry package.
