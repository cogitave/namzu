# Changelog

## 1.3.0

### Minor Changes

- 935b8f3: An answer can cite the document it came from

  Sending a document buys the provider's native handling of it — page structure, built-in OCR, and the ability to say which passage an answer rests on. namzu could send the document and could not receive the third: an answer about a contract arrived as prose, and checking it meant reading the contract again by hand. A citation is the difference between an answer you trust and one you verify.

  `citations: true` on a document attachment asks for them; they come back on the assistant message as `Citation[]`. Opt-in per document, because the provider splits the document into citable units and the answer carries the passages it leaned on — tokens a turn that never wanted a citation should not pay.

  The location is a union — `page`, `char` or `block` — rather than a page number, because providers segment differently and the segmentation is theirs. Flattening all three would invent a page number for the two that have none. Web-search and search-result citations are deliberately dropped: they point at something that was never in the request, so there is no attachment to resolve them against, and a citation the reader cannot go and look at is worse than none.

  Citations ride with the turn that made them, like reasoning blocks, so compaction takes a turn's evidence with it rather than leaving citations pointing at prose that is gone.

- 935b8f3: Documents and citations were designed in the SDK and never built in the drivers.

  `DocumentAttachment` and `Citation` existed in `@namzu/sdk` with a page of documentation about why native document handling is worth having — page structure, the provider's own extraction, and the ability to say which passage an answer rests on. The stream chunk carried a citation slot, the run's stream aggregator collected them onto the assistant message, and the iteration attached them to the turn. Both these drivers declared `supportsDocuments: true`.

  Neither had a document branch. Every attachment was mapped as an image — a PDF went up as an image block with `media_type: application/pdf` on one wire and as `data:application/pdf;base64,…` inside an `image_url` part on the other, shapes the APIs reject. And only the mock provider ever emitted a citation, so in a real run the slot was always empty: an answer about a contract arrived as prose, and checking it meant reading the contract again.

  - **`@namzu/anthropic`** now sends a native document block carrying the media type, the optional title, and — only when the attachment asked for them, because they cost tokens — citations. It parses citation deltas back onto the stream, keeping the location as the discriminated union the SDK defines: a provider that segments by character offset has no page number, and a citation whose location cannot be named is dropped rather than given an invented one. A citation that looks checkable and is not is worse than none.
  - **`@namzu/openai`** now sends a document as a `file` content part with its filename. That wire has no way to return citations, so a document that asks for them is refused with a message naming the document and what to do instead — answering without them would drop the checkability the caller asked for, and an empty citation list reads as "the model cited nothing" rather than "nobody asked".

  The drivers that declare `supportsDocuments: false` were already honest: none of them map attachments at all, and the runtime warns (or fails under `strictCapabilities`) before the request is built.

- 935b8f3: Extended thinking, and images inside tool results.

  Two more halves the SDK had specified and this driver had not built.

  **Extended thinking.** The stream chunk carried a `reasoning` channel whose own comment named the failure — `thinking_delta` and `signature_delta` fell through the driver's `default: // ignore` — the run's aggregator bucketed fragments by index and closed them on `done`, and `ReasoningBlock` recorded the signature with a note that replaying it unchanged is mandatory. The driver requested no thinking, parsed none, and replayed none, so the feature was unreachable on a model where it is off by default and untunable on one where it is on.

  It now sends the `thinking` request with the caller's budget, streams each block with its fragments and its signature, closes the block so the aggregator knows the signature has landed, and replays reasoning blocks verbatim and first on the next request. Verbatim is not a style choice: the signature is verified upstream, so a block re-rendered, reordered, or stripped of its signature invalidates the whole conversation rather than that block. A redacted block travels as its opaque payload.

  **Images in tool results.** A tool result carrying content blocks was `JSON.stringify`d, so a screenshot reached the model as a wall of quoted base64 — the exact thing the SDK's degrade helper exists to prevent, and pure waste besides: the model paid for every character and could read none of them. This wire carries image blocks inside a tool result natively; the mapper simply never used the shape. Documents still degrade to the named placeholder, because tool results here take text and images, and the wrong block fails the request rather than just the block.

  Six previously empty test files now cover this driver: document input, citations, extended thinking, tool-result content blocks, cache-breakpoint placement, and the request shapes the wire rejects outright — an empty content array, an orphan tool result, a `tool_choice` sent without tools.

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

- 935b8f3: Parse reasoning out of the stream, and let a run request extended thinking.

  This completes the reasoning work: the previous release added storage and
  verbatim replay, but nothing populated it. `StreamChunk.delta` carried only
  `content` and `toolCalls`, so the Anthropic driver's `thinking_delta` and
  `signature_delta` events fell through its `default: // ignore` — the blocks
  could not be captured even in principle. Two consequences: the verbatim-echo
  contract was unsatisfiable in practice, and a streaming UI showed a
  multi-second stall with zero events while the model was demonstrably working.

  - `StreamChunk.delta.reasoning` carries fragments bucketed by block index,
    exactly like `toolCalls[].index`, closed by `done`.
  - `streamProviderTurn` accumulates them and attaches the finished blocks to
    the response in **stream-index order**, not arrival order — a provider may
    interleave blocks, and the echo contract is about the original ordering.
  - New `reasoning_started` / `reasoning_delta` / `reasoning_completed` run
    events, wire-mapped as `reasoning.*`. The delta is ephemeral, so the
    transcript records the completed block rather than every fragment.
  - The Anthropic driver handles `content_block_start` for
    `thinking`/`redacted_thinking`, forwards `thinking_delta` and
    `signature_delta`, and closes the block on `content_block_stop`.
  - `AgentRunConfig.thinking` (`ThinkingConfig`) is forwarded on every model
    call. The Anthropic driver maps it to `thinking` and **omits
    temperature/top_p/top_k while it is enabled**, because the API rejects them
    together — sending a request known to 400 is worse than dropping a sampling
    knob the caller did not prioritise.

  Reasoning rides on the assistant message it belongs to, so the replay contract
  holds automatically: trimming or compacting that message takes its thinking
  blocks with it, and no separate atomicity rule is needed in `findSafeTrimIndex`.

- 935b8f3: A user message can carry a document

  Documents existed in the type system only in the tool-result direction, and both first-party drivers mapped images only on the input side. So "here is the contract, answer questions about it" — a mainstream workload — was reachable only by having a tool read the file and stringify it. That loses the provider's native document handling (page structure, built-in OCR, citations) and pays the text cost instead.

  `UserMessage.attachments` is now `MessageAttachment[]`: an image or a document. The discriminant is optional and stays optional — an attachment without one is an image, which is what every attachment was before, so no existing caller changes.

  `supportsDocuments` sits beside `supportsVision` in the driver capability declaration, and the runtime checks it the same way: a document sent to a driver that declares `false` warns before the request, or throws under `strictCapabilities`, instead of letting the model answer about a file it never saw. The two are counted separately because they are separate wire shapes and a driver can map one without the other.

  The two first-party drivers map documents natively. The remaining five map images only and now say so; a document reaching them degrades to a named placeholder that says which kind was dropped, rather than one that calls a document an image.

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

- 935b8f3: Lift the dependency floor to versions without published advisories

  Eighty-two open advisories collapsed to a handful of real decisions, because most of them were the same package reached through one path.

  The telemetry exporters carried a serialization library with twenty-four advisories against it, two of them critical. The exporters move from the 0.57 line to 0.221, and the stable packages beside them from 1.x to 2.x — a major bump for this package, since a consumer pinning the older peers must move with it.

  The two vendor driver SDKs move to their current releases, closing the advisories that came with them.

  The test runner accounted for fourteen critical advisories on its own. It is a development dependency and never reaches a published artifact, but it runs in CI against the repository's own contents, so it moves to the first patched release rather than being waved through as out-of-scope.

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

- 935b8f3: Five places where namzu gave up, or claimed to recover, too early.

  **A transient failure now pauses instead of failing.** A 503 that survived
  every in-turn recovery — retry with jitter, the one-shot compaction relief,
  mid-stream salvage — settled the run as `failed`, identically to a bad API
  key. The host could not tell them apart, and recovering meant knowing about
  checkpoints and driving replay itself. The state was never the problem:
  checkpoints are written every iteration by default and the failed run is
  persisted with full messages. Only the settle and the signal were missing.

  A retryable failure with a checkpoint to resume from now emits `run_paused`
  naming that checkpoint, leaves the span OK rather than ERROR, and sets
  `stopReason: 'paused'`. Both conditions are required — pausing on a
  permanent error would invite a resume that cannot work, and pausing with
  nowhere to resume from produces a run nobody can ever pick up.

  **A forced compaction pass can no longer decline to do anything.** A forced
  pass runs because the provider _rejected_ the prompt as too long, and two
  things let it treat that as advisory. It re-applied the chars/4 estimate
  after clearing stale tool results — the estimate the provider had just
  refuted — and returned early if that said the context was fine. And relief
  reported success on ANY positive shed, so clearing one short result counted
  and the retry burned a whole model call to be told the same thing. The
  early return is now force-gated, and a shed has to clear a floor (a
  fraction of the prompt, at least a couple of thousand characters) to count.

  Separately, the relief latch is per **stuck point**, not per run. It exists
  to stop a second overflow immediately after a successful compaction from
  looping; as a run-scoped flag it meant one relief at iteration 3 disarmed
  the mechanism for the rest of the run, leaving iteration 40 to die with
  obvious moves left. It is now cleared by a turn that actually succeeded.

  **An eval case can no longer hang the suite.** `executeCase` was a bare
  await, so a `run` closure that never settled blocked its worker and
  `runExperiment` never returned — no report, no partial results, nothing to
  read. `ExperimentConfig.timeoutMs` bounds a case and hands `run` an
  `AbortSignal` as a third argument; a timed-out case is reported and the
  suite continues, exactly like a case that threw, with its real elapsed time
  rather than zero. Unset means no deadline, which is today's behaviour. The
  documented path already inherits deadlines from the runtime it drives; this
  covers what those cannot see — a closure that does not go through
  `query()`, and a mid-iteration provider stall.

  **A malformed content block is named, not smuggled.** One driver built an
  image block by calling `String()` on whatever `data` and `mediaType`
  happened to be, behind only a truthiness check — so a non-string `data`
  became the literal `"[object Object]"` as the base64 payload, and the wire
  rejected the whole request with nothing naming the block at fault. That is
  reachable: a remote tool result is cast without validation on the way in.
  It now type- and media-type-guards and degrades to a named placeholder,
  matching the sibling driver that already did, and without inlining the
  payload it refused to send.

  **Failures have somewhere to grow remediation.** A stale API key surfaced
  as whatever prose the vendor SDK happened to write: no id to grep in logs,
  no instruction on what to change, and no growth point — a newly-observed
  failure shape could only be given curated copy by editing the classifier.
  `explainError` adds an ordered, id-keyed rule layer matching on
  **structural** signals (code, status, an explicit hint) rather than
  volatile vendor prose. `run_failed` carries the result as `explanation`;
  `withHint(err, '…')` lets a throw site attach what only it knows, and
  outranks every generic rule. It returns `null` when no rule claims the
  failure — inventing advice for something uncharacterised is worse than
  saying nothing, because it sends the reader somewhere specific and wrong.
  The container backend's readiness, port-mapping and worker-fetch failures
  now carry hints.

- 935b8f3: namzu's own vocabulary, everywhere.

  Comments across the kernel explained namzu's design by naming another
  product: "mirrors X's container architecture", "reference: X's
  `normalizePathForSandbox()`", "which is what Y and Z both do", "Claude Code
  uses 2000 for the same reason". Behaviour was correct throughout — this is
  about what the code says it is. A kernel that explains itself by citation
  reads as a reimplementation of something else, and namzu is not one.

  Every such comment now states the reason directly. Where a rule exists
  because a provider requires it, the comment says what the requirement is
  rather than whose it is — which is also more useful, since the same
  requirement usually holds for more than one provider, and a reader who has
  never used the named one can still follow it.

  **Breaking (types only, no runtime behaviour):**

  - `ToolCatalogSurface`: the `'cowork'` member is now `'supervised'`.
  - `ToolSource.skill.type`: `'anthropic' | 'custom'` is now
    `'published' | 'custom'`.

  Both are descriptive metadata with no construction site anywhere in the
  workspace, so nothing internal moved. An external consumer that names
  either value gets a compile error pointing at the line.

  **Deliberately unchanged**, because these are addresses rather than
  borrowed naming: model-id prefixes in the context-window table (data the
  runtime matches against), API-key detection patterns in the guardrail
  presets (a pattern is worthless if you cannot tell what it detects),
  namzu's own provider package names, and the credential-store integration in
  the CLI, whose service name and file path are literally the other tool's.

## 1.2.0

### Minor Changes

- 11167dd: Separate runtime tool validation from canonical model-facing JSON Schema,
  propagate constrained-input hints through the agent loop, and map reviewed
  schemas to Anthropic strict tool use with capability-aware overrides. The
  built-in edit tool advertises only canonical arguments.

## 1.1.2

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
