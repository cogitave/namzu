# @namzu/deepseek

## 1.0.0

### Major Changes

- ee4fd1d: Persist provider-native reasoning state with the exact provider, model, and fallback-chain member that produced it. Same-route sessions now replay native reasoning after restart, `/resume`, and `/fork`; a model, provider, or member switch keeps portable assistant/tool history without sending foreign native reasoning metadata.

  `@namzu/sdk` adds `ProviderRoute`, `AssistantMessageSource`, optional assistant source/replay fields, and the provider request/stream/response plumbing. Fallback and forced-final turns now attribute provenance and cost to the member that actually answered.

  `@namzu/cli` preserves and validates the additive assistant source shape in stateless and durable history.

  **What breaks in the drivers:** hand-built assistant reasoning and histories written by earlier versions do not carry a validated route-bound replay envelope, so they are no longer emitted as native `reasoning_content` or signed thinking. Their portable assistant text and tool exchanges remain available, but an upstream that requires native metadata for an old tool continuation may refuse that request; compact or start a fresh conversation before continuing such legacy history. Preserve the complete assistant message returned by new runs, including `source.replayState`. Direct callers of the exported DeepSeek `toDeepSeekMessages` converter must also pass the target `ProviderRoute` as its second argument.

### Minor Changes

- 94d3306: Add the chain-aware `reasoningEffortLevelsFor(model, thinking)` provider capability while retaining `effortLevelsFor` as a deprecated compatibility member. The four capability states now distinguish a driver with no menu, an unknown model, an explicitly unsupported model, and an exact selectable set; fallback chains expose only levels every reachable member accepts.

  The TUI adds session-scoped `/effort [level|default]`, sends the selection to later main-query turns, and resets it atomically when a provider/model replacement succeeds. Failed or cancelled replacements preserve the current selection.

  OpenAI publishes exact known-model menus and keeps unknown compatible-endpoint models unknown. DeepSeek explicitly publishes no supported levels. Anthropic now refuses unsupported effort levels before transport instead of silently dropping them; callers upgrading Anthropic must choose a level returned by `reasoningEffortLevelsFor()` or omit `effort` to retain the provider default.

### Patch Changes

- 15f8ee4: Bound provider stream silence, including query-owned advisory calls and
  RouterAgent routing decisions, compaction verifiers and model-graded eval
  judges, to five minutes by default and abort the stalled provider transport,
  with network-classified retry and fallback recovery where those policies
  apply. This changes the previous default, under which a provider iterator could
  remain silent forever. Set `streamIdleTimeoutMs: 0` on the run, agent, manual
  compaction, verifier, or judge config to keep the old unbounded behavior, or set
  a positive millisecond value to choose a different bound.

  Queries whose caller signal is already aborted now settle as cancelled before
  starting provider, provider-metadata, or tool work. A later cancellation also
  settles while an optional context-window resolver remains pending, even when
  that resolver ignores its signal. With no caller cancellation, `timeoutMs`
  bounds the optional metadata lookup, aborts its private transport signal, and
  falls back to the static context-window table instead of blocking the run.

  The OpenRouter context-window lookup now forwards cancellation to its model-list
  transport. Only fulfilled listings are cached, so cancelling one concurrent
  query cannot abort another query's shared metadata request or force that query
  onto the static context-window table.

  `runExperiment({ timeoutMs })` now applies one validated wall-clock deadline to
  both case execution and scoring. Scorers receive its optional cancellation
  signal; a non-cooperative scorer is detached, and `judgeScorer` forwards the
  signal to its bounded provider transport. Values outside the positive platform
  timer range are refused before a case starts; omit the field for the prior
  unbounded case behavior.

  Compaction verification inside a query now carries the run cancellation cause
  to its provider transport without placing a second idle timer around retry and
  fallback. Public `buildVerifiedSummary`, `compactNow`, and `compactRegion`
  calls bound raw provider silence themselves and accept optional `signal` and
  `streamIdleTimeoutMs`; malformed values and pre-cancelled manual work are
  refused before provider work or a no-op result.

  HTTP embedding batches now have a 30-second whole-request default, including
  response-body reads, where the previous default could wait forever. Set
  `requestTimeoutMs: 0` on `HttpEmbeddingProvider` to keep the former unbounded
  behavior. Invalid timeout values and non-positive or fractional `batchSize`
  or `dimensions` values are refused at construction instead of silently
  disabling the bound or entering a non-progressing batch loop. Successful HTTP
  responses must contain exactly one unique, in-range result per input and finite
  vectors of the configured dimension; malformed or incomplete batches are
  refused atomically instead of reaching ingestion with missing embeddings.

  Public RAG operations accept optional cancellation context. The shipped
  `knowledge_search` tool forwards its run-owned signal through
  `KnowledgeBase`, retrieval or ingestion, and the embedding provider. The HTTP
  provider preserves the caller's exact cancellation reason while aborting only
  its private fetch transport. Custom embedding providers receive the signal as
  a cooperative request; callers still own their wait boundary if a custom
  implementation ignores it. Default retrieval and ingestion recheck authority
  after that custom call settles, so a late result cannot start a vector search
  or persist chunks after cancellation. `VectorStore.search` and `upsert` now
  receive the same optional operation context. The default pipelines also race
  those store promises against cancellation, so a non-cooperative custom store
  cannot leave the public query or ingestion call pending forever.

  A2A agent-card discovery now has a 30-second whole fetch-and-body default and
  accepts an optional caller signal and `timeoutMs`; set `timeoutMs: 0` to retain
  the former unbounded behavior. `A2ADelegate.timeoutMs` now starts before
  `message/send` and bounds the whole delegation instead of polling only. A
  pre-cancelled dispatch starts no remote work, pending fetch and body promises
  cannot hold `waitForTask`, and caller cancellation preserves its exact cause on
  the private transport. Poll and delegation timers are validated at
  construction. Once a safe task id exists, cancellation or timeout sends one
  independently bounded `tasks/cancel`; during initial task creation the client
  keeps a short cleanup grace and explicitly reports an unknown remote outcome if
  the peer never returns an addressable id. Poll replies are bound to that initial
  id, and transport or protocol failures after it is known make the same bounded
  cleanup attempt before the original failure is returned. An `input-required`
  task is also bounded-cancelled before the delegate reports that it cannot
  supply the requested input.

  Connector execution now carries optional operation authority through the
  manager, every connector-tool adapter, real query runs, tenant/environment
  facades, health checks, and `MCPConnectorBridge.callTool`. Custom connectors
  receive the signal; if they ignore it, the manager settles with an honest
  unknown remote outcome and rejects a late success that does not identify a
  received response. A tenant call cancelled before admission no longer spends a
  rate-limit slot.

  `HttpConnector` and `WebhookConnector` now apply one validated 30-second
  fetch-and-body deadline and a streaming 2 MiB response limit by default. Set
  positive `timeoutMs` and `maxResponseBytes` values to choose different bounds.
  Cancellation, deadline, or response-size failure aborts only the private
  transport/body reader and preserves the caller's exact cause. Result metadata
  distinguishes `not_started`, `unknown`, and `response_received`, includes retry
  safety, and keeps a received status visible when its body is unavailable.

  Dynamic HTTP paths and webhook URL overrides must remain on the configured
  origin. Model-authored routing headers are refused, redirects are not followed,
  and 3xx responses are no longer reported as success. Configure a separate
  connector instance for each authorized origin; callers that previously used a
  cross-origin webhook override must migrate to that instance.

  `GuardedFetchProvider` now applies one validated 30-second deadline across DNS
  resolution, every manually admitted redirect fetch, and the final response
  body, while preserving a caller's exact cancellation cause on a private
  transport signal. Its 2 MiB default response cap is enforced from streamed
  bytes rather than after `response.text()` allocates the whole body; overflow
  cancels the reader and returns a valid UTF-8 prefix. Redirect bodies are
  cancelled when abandoned, and a spent redirect budget causes no DNS lookup for
  the next target. Set positive `timeoutMs` and `maxBytes` values or a
  non-negative integer `maxRedirects` to choose other bounds. Custom
  `GuardedFetchConfig.resolve` functions may now accept the operation signal as
  a second argument. IPv4-mapped IPv6 literals are canonicalized back to their
  IPv4 address before range checks, closing the hexadecimal mapped loopback and
  link-local bypass; the full IPv6 link-local and multicast ranges are also
  refused.

  MCP request methods now accept optional cancellation authority, and generated
  MCP tool and prompt adapters forward the run-owned tool signal. A pre-aborted
  request starts no transport work; a pending request preserves the caller's
  exact cause, aborts a private transport, removes its correlated pending id, and
  makes a one-second best-effort `notifications/cancelled` attempt. The
  notification does not prove that an already-started remote side effect stopped.
  Paged list calls recheck the same signal before each page.

  `MCPClient.requestTimeoutMs` and HTTP MCP transport `timeoutMs` values must now
  be positive platform-range integers. A shorter transport deadline remains a
  request-timeout terminal and emits the same correlated cancellation. HTTP
  fetches and response-body reads share operation authority; disconnect owns
  active requests and cancellation cleanup. Reconnects fence late POST responses
  and SSE batches from prior generations, clear Streamable session state, and
  accept session ids only from successful `initialize` responses. Per-send
  failure no longer marks a Streamable client connection-wide errored or rejects
  unrelated concurrent calls. `MCPTransport.send` now accepts optional
  `MCPTransportSendOptions`; custom transports should refuse pre-aborted work and
  stop their per-send I/O when its signal fires.

  Provider model listings and credential probes now accept optional cancellation
  signals. Retry, fallback, stream-idle and instrumentation decorators preserve
  that authority, and every bundled CLI driver forwards it to the underlying
  transport where supported or refuses a result that arrived after cancellation.
  Existing zero-argument provider implementations remain valid.

  The interactive provider picker now cancels model discovery, credential checks
  and subscription sign-in when the operator backs out, supersedes the work, or
  leaves the screen. Late results cannot reopen an old model step, accept a
  credential, re-probe the application, or persist a subscription credential
  after cancellation. Model listing and credential probing both settle after a
  three-second bound even when a custom provider ignores its signal.

  Between-turn and durable-resume subscription refreshes now settle on caller
  cancellation and apply one 30-second bound across the token request and response
  body. Refreshes in one session are serialized and re-read their source at the
  head of the queue, preventing a later stale caller from downgrading a token
  published by an earlier one. Namzu's credential file uses an exact conditional
  replacement under a cross-process, atomically published lock; an external
  rotation or logout wins, and an uncertain publication refuses instead of using
  an uncommitted refresh. Borrowed macOS Keychain credentials are read-only: a
  changed or removed entry wins, and a successful refresh of an unchanged entry
  remains session-local.

## 0.1.0

### Minor Changes

- 7050dd4: Add `@namzu/deepseek`, and stop dropping reasoning when a stream is collected.

  **A new driver, and a separate package on purpose.** DeepSeek's endpoint is OpenAI's Chat Completions shape, so pointing `@namzu/openai` at it with a `baseURL` looks like it should work. It does not, and the reason is thinking mode: it is **on by default**, the chain of thought comes back in a `reasoning_content` field that wire has no concept of, and the vendor requires that field replayed on every later turn once tool calls are in play. A driver that does not know about it drops the model's reasoning on every call.

  `@namzu/deepseek` maps `ThinkingConfig` one-to-one onto the vendor's own `adaptive | enabled | disabled`, streams reasoning through `delta.reasoning` — the same channel `@namzu/anthropic` uses, so a host that renders one renders the other — and replays it automatically. Callers pass the assistant message back and the field goes with it.

  It **refuses** two things the vendor accepts and applies to nothing: `effort` (this wire validates `thinking.type` and ignores any effort beside it) and the sampling parameters while thinking is on. Both were measured against the live API rather than read off the documentation. `samplingInThinkingMode: 'ignore'` opts out of the second.

  It carries no price rows, deliberately: the vendor charges twice as much during peak UTC hours, and a static table has no hour in it.

  **`collectChatCompletion` dropped reasoning blocks** (`@namzu/sdk`). `delta.reasoning` existed, `AssistantMessage.reasoning` is documented as replayed verbatim, and the run loop assembled it correctly — but this helper, which every non-streaming caller goes through, threw it away. So the same stream produced a message with reasoning through one route and without it through the other, and a vendor that needs the blocks back was sent a message that had lost them. It now buckets them by index exactly as the run loop does. This affects `@namzu/anthropic` users too.

  **The CLI ships the driver** (`@namzu/cli`), so `namzu --provider deepseek` works on a fresh install with `DEEPSEEK_API_KEY` set. That is a fifth bundled driver and a slightly larger install.

  Models are `deepseek-v4-flash` and `deepseek-v4-pro`. `deepseek-chat` and `deepseek-reasoner` were discontinued on 2026-07-24 and resolve to nothing.
