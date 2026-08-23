# Changelog

## 4.0.1

### Patch Changes

- 9e1c9a3: Repair Claude subscription sign-in by matching the current registered browser request, letting the provider picker accept its returned authorization code, and preserving the subscription-routing identity on model requests. Print the TUI banner once during boot and keep the permanent idle key legend out of the footer while preserving state-specific interaction hints.

## 4.0.0

### Major Changes

- 94d3306: Add the chain-aware `reasoningEffortLevelsFor(model, thinking)` provider capability while retaining `effortLevelsFor` as a deprecated compatibility member. The four capability states now distinguish a driver with no menu, an unknown model, an explicitly unsupported model, and an exact selectable set; fallback chains expose only levels every reachable member accepts.

  The TUI adds session-scoped `/effort [level|default]`, sends the selection to later main-query turns, and resets it atomically when a provider/model replacement succeeds. Failed or cancelled replacements preserve the current selection.

  OpenAI publishes exact known-model menus and keeps unknown compatible-endpoint models unknown. DeepSeek explicitly publishes no supported levels. Anthropic now refuses unsupported effort levels before transport instead of silently dropping them; callers upgrading Anthropic must choose a level returned by `reasoningEffortLevelsFor()` or omit `effort` to retain the provider default.

- ee4fd1d: Persist provider-native reasoning state with the exact provider, model, and fallback-chain member that produced it. Same-route sessions now replay native reasoning after restart, `/resume`, and `/fork`; a model, provider, or member switch keeps portable assistant/tool history without sending foreign native reasoning metadata.

  `@namzu/sdk` adds `ProviderRoute`, `AssistantMessageSource`, optional assistant source/replay fields, and the provider request/stream/response plumbing. Fallback and forced-final turns now attribute provenance and cost to the member that actually answered.

  `@namzu/cli` preserves and validates the additive assistant source shape in stateless and durable history.

  **What breaks in the drivers:** hand-built assistant reasoning and histories written by earlier versions do not carry a validated route-bound replay envelope, so they are no longer emitted as native `reasoning_content` or signed thinking. Their portable assistant text and tool exchanges remain available, but an upstream that requires native metadata for an old tool continuation may refuse that request; compact or start a fresh conversation before continuing such legacy history. Preserve the complete assistant message returned by new runs, including `source.replayState`. Direct callers of the exported DeepSeek `toDeepSeekMessages` converter must also pass the target `ProviderRoute` as its second argument.

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

## 3.4.0

### Minor Changes

- 03e363c: Declare the Node floor these packages already had, and export a type `TelemetryConfig` already required.

  **`engines.node: ">=20.0.0"`.** Only `@namzu/cli` declared one; the other fourteen published without any, so npm could not warn a consumer installing onto an unsupported runtime — they got a crash at some later import instead. The floor is not new: `@namzu/cli` has declared it since it shipped and `install.sh` has enforced it since it existed. This makes the other fourteen say the same thing.

  If you install with `engine-strict=true` on Node 18, an install that previously emitted nothing will now fail. Upgrade to Node 20 or newer, which the code already assumed. Everyone else sees no change, or an `EBADENGINE` warning that replaces a later crash.

  Worth stating plainly: CI verifies Node 22 and 24. The 20 floor is a declared minimum, not a tested one.

  **`SpanProcessorLike` is now exported from `@namzu/telemetry`.** `TelemetryConfig.spanProcessors` takes `readonly SpanProcessorLike[]`, and the type had no export — a field on the public surface whose type was not on it, so a host supplying the value had to inline the shape or reach for `any`.

## 3.3.2

### Patch Changes

- 5394981: Make each driver's README an npm package page rather than its manual.

  Every driver README carried its full reference — configuration tables, capability matrices, error surfaces — between 167 and 392 lines of it. That is a reasonable shape for a single-package repository, where the README _is_ the documentation, and the wrong one for a package in a monorepo that has a `docs/` tree: it duplicates what the docs say, and nothing checks that the two agree.

  The README is now what a reader needs in the first minute — what the driver is, install, one working example, links. The reference moved to `docs/providers/<name>.md`, whole, and its code samples are now compiled against the built SDK by the doc-fence gate on every CI run. They never were before; several did not compile.

  No API change.

## 3.3.1

### Patch Changes

- 3331493: A message can carry a reference to an attachment instead of its bytes.

  Every attachment was inline base64 on the message. That is fine for one screenshot and wrong for everything it implies: the bytes are copied into the run's durable transcript, into every checkpoint, into every compaction pass that walks the history, and — because a conversation resends its history — into every subsequent request. A 4 MB PDF attached once is 4 MB in the transcript and 4 MB on the wire per turn for the rest of the run.

  New: `StoredAttachmentRef` as a third member of `MessageAttachment`, the `AttachmentStore` seam, and `attachmentStore` on `query`. The kernel treats `ref` as **opaque** — this seam says nothing about whether it is a hash, a path or a URL, because the store that minted it is the only thing that can answer. A content-addressed store gets deduplication for free; this interface neither requires nor prevents that.

  Resolution happens once, where the run is seeded, before the messages reach the run record. Resolving at the provider boundary instead would put refs in the durable transcript, and a run resumed against a store that had since forgotten a ref would fail replaying its own history rather than at the moment somebody asked for the bytes.

  **Every failure refuses**, and none of the three returns the message unchanged: no store, no such ref, and bytes whose media type is not what the message declared. A message that quietly lost its image is a model answering about a picture it never saw, confidently, with nothing in the transcript saying why. One unresolvable ref refuses the whole conversation rather than resolving what it can.

  Both provider drivers refuse an unresolved stored attachment rather than sending `data: undefined`. The OpenAI driver reads the real SDK type and the compiler caught it; the Anthropic driver reads through a structural cast and did not, so the stored member is spelled out in its local type — that difference is written at the site.

## 3.3.0

### Minor Changes

- a4bcbc9: Runs report what they cost, and a cost limit that cannot be measured is refused

  Every run reported `$0.00`. `calculateCost` existed and `CostInfo` was carried on
  the run, the step, the checkpoint and the `token_usage_updated` event — but a
  turn was only priced when the host passed `pricing` to `query()`, and no shipped
  surface passed one. The accumulation branch was dead everywhere.

  `runConfig.costLimitUsd` is enforced against that same total, so a host that set
  a cost cap did not have one, and nothing said so.

  **`@namzu/sdk` now ships a price catalogue** — `packages/sdk/src/pricing/`, a
  module generated from a reviewed in-tree source table and checked in, so a cost
  number is reproducible from a commit and an offline run still prices correctly.
  Rates are looked up per turn against the driver and model that actually served
  it. No configuration is needed to get a real number.

  ## What every caller sees change

  **A run that reported zero now reports a real number.** If you compare, store,
  bill from, or assert on `Run.costInfo.totalCost`, the value moves on the same
  inputs. Nothing about your code has to change for this — but nothing warns you
  either, so check anywhere a zero was being relied upon.

  **A `costLimitUsd` that was inert now enforces, or refuses.** This is the change
  most likely to break a working deployment, and it can do so at two moments:

  - `query()` throws `invalid_config` at the start of a run when `costLimitUsd` is
    set, no `pricing` is supplied, and the configured model has no rate. Same
    config, same model, previously-completing run — now a startup failure.
  - A run stops with the new `cost_unmeasurable` stop reason when a step or a
    provider-chain member swaps to a model with no rate mid-run.

  To keep a run working, do one of: pass `pricing` to declare the rate yourself;
  add the model to `packages/sdk/src/pricing/rates.source.json` and regenerate;
  or drop `costLimitUsd` and bound the run with `tokenBudget`, which is always
  measurable. Removing the limit is the honest option if the model cannot be
  priced — a budget you cannot measure was never enforcing anything.

  ## Breaking API changes

  - **`CostInfo.inputCostPer1M` and `CostInfo.outputCostPer1M` are now optional.**
    Absent means no single rate card describes the total — the run spanned two
    models, or part of it ran at no known rate. Readers that treated these as
    `number` need a `?? ` or a branch. They were previously required and reported
    whichever card was applied last, which was a claim about the whole total that
    was true of only part of it.
  - **`CostInfo` gains a required `unpricedTokens: number`.** Any code that
    constructs a `CostInfo` must supply it. Zero means nothing is unaccounted for.
    This is what lets a consumer tell "this run cost nothing" from "nobody knows
    what this run cost" — previously both were `totalCost: 0`.
  - **`calculateCost` and `accumulateCost` lost their trailing `cacheDiscount`
    parameter.** It defaulted to `0`, no caller in the tree ever passed it, and
    the value it produced was subtracted from the total. `cacheDiscount` is now
    computed from the rate card and _reported_ rather than subtracted — it is what
    the cache reads saved against the full input rate, and the saving is already
    inside `totalCost`. Callers passing a fourth argument get a compile error;
    drop it.
  - **`StopReason` gains `cost_unmeasurable`.** Exhaustive switches over
    `StopReason` will not compile until they handle it.
  - **`RunPersistence.accumulateUsage` and `recordTurnUsage` take a second
    required argument** naming who served the tokens. Required so a call site
    cannot silently misattribute; pass `{ providerId, model }`.
  - **`projectEmergencyToCheckpoint` no longer reports zero cost.** A dump
    preserves a real `tokenUsage` and records no cost, so the projection now
    states that those tokens are unpriced rather than that they were free.

  ## Also fixed

  - The advisory executor reported `totalCost: 0` for an advisor with no pricing
    table — zero-as-unknown, the same defect one file over. It now reports the
    tokens as unpriced, and falls back to the catalogue before giving up.
  - Cache tokens are priced. The drivers in this repository disagree about whether
    the prompt-token count already contains cache reads (two exclude them, one
    includes them), so that fact is declared per driver in the rate source and the
    arithmetic reads it. Previously cache reads were charged at the full input
    rate or not at all, depending on the driver, and `cacheDiscount` was dead.

  ## `@namzu/anthropic`

  The driver's offline model menu moves to an exported `OFFLINE_MODEL_CATALOGUE`
  so a test can read it without a client. Two of the three models it offers had no
  rate in the catalogue — a lookup-key mismatch that reads as "cost unknown" and
  that the generator's own regeneration check is structurally blind to. Both rates
  are added and a conformance test now holds the two lists together. No behaviour
  change for callers.

## 3.2.0

### Minor Changes

- d3bd080: A wrong API key is no longer reported as working

  Typing a key into the picker ran a check that could not fail for two providers.
  Measured against deliberately invalid keys, both said the key was good.

  **With an OpenRouter key, any string at all passed.** A typo, the wrong
  clipboard entry, a revoked key — all were accepted and reported as verified. The
  check listed the model catalogue and treated a successful list as a passed
  check, and OpenRouter's catalogue endpoint does not authenticate, so it answered
  the same way whatever was sent. Nothing was wrong with that driver's listing; a
  catalogue was simply never evidence about a key.

  **With an Anthropic key, a real rejection was discarded.** The listing caught
  the `401` and returned a hardcoded three-model list, which the check read as
  success — so the truth existed, was thrown away, and was replaced by something
  that looked like an answer.

  A credential check is now a separate, declared capability. A driver that
  declares no probe is reported as **not checked**, never as verified, so a driver
  added in future cannot silently inherit a check it does not perform. Anthropic,
  OpenRouter, OpenAI and Ollama declare one; OpenRouter's asks about the key
  rather than the catalogue.

  Refusal and doubt stay distinct. A `401` means the key is genuinely refused; a
  timeout or a DNS failure means nothing was learned, and is reported that way —
  telling someone on a broken connection to rotate a working key is a different
  error, not a smaller one.

  **Anthropic's model listing also never once ran.** The SDK method was pulled out
  of its namespace and called bare, so it lost `this`, threw a `TypeError` on
  every call, and was swallowed by the same catch — the hardcoded models were not
  a fallback but the only answer the method could give. It now calls the live
  endpoint, and falls back only when that genuinely fails.

  The four driver packages are `minor` rather than `patch`: each gains a method
  it did not have, and added functionality is a minor whatever the size of the
  diff. Anthropic's earns it twice over, because its listing now returns the live
  catalogue where it previously returned the same three hardcoded entries to every
  caller - so the value every existing caller receives changes.

## 3.1.1

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

## 3.1.0

### Minor Changes

- 585a592: A caller can ask which effort levels a model accepts.

  The answer existed, was modelled carefully, and was reachable only from inside
  one driver. That matters because effort is **refused, not clamped**: a level a
  model does not have makes the vendor reject the request, so a control offering
  the wrong one produces a run that fails at the start rather than a quieter one.

  Every option open to a caller without the answer was bad. Offering all five
  breaks some models. Offering the intersection hides `xhigh` and `max` from every
  model that has them, which is most of the reason to build such a control. And
  copying the table looks fine and is worst: the ceiling has moved twice already,
  so a copy goes stale on the next model and goes stale **silently**, surfacing as
  a vendor rejection rather than a failing build.

  **New optional `LLMProvider.effortLevelsFor(model, thinking?)`.** Three states,
  each meaning something different: the method absent means the driver has no
  effort concept at all and setting one will be refused; an empty array means the
  driver implements effort and this model has none; a non-empty array is the set
  to offer.

  **`thinking` is a parameter, and that is the point.** At least one model family
  accepts a narrower set while thinking is disabled than while it is on — so an
  API returning two sibling arrays invites a caller to render a picker from one
  and send the other, a combination the vendor rejects, on exactly one family.
  Passing the configuration you will actually send makes that unspellable: there
  is one answer and it is the one for your request.

  The driver's implementation shares the same two resolution steps the request
  path uses, so a caller's picker and the request it produces cannot disagree.

  `@namzu/anthropic` also now exports `resolveThinkingCapability`,
  `resolveThinkingBody`, `resolveEffort` and their types, for a caller that needs
  the fuller picture — whether thinking can be switched off at all, not only which
  effort levels apply. Prefer `effortLevelsFor` where it suffices: it is
  provider-agnostic and cannot return the wrong one of the two sets.

  Separately, the live wire-contract suite now retries a transient status rather
  than reporting it as a contract failure. A 529 says the service is busy and
  answers nothing about whether a schema is expressible — so a test named "every
  shipped tool is expressible on this wire" was claiming something the run had not
  established. That cost two manual re-runs in one day to discover the wire had no
  opinion.

## 3.0.1

### Patch Changes

- 062624c: `effort` can be set on a run — and so, for the first time, can `thinking`.

  `effort` was on the provider params, exported, and read by a driver that wrote
  it to the wire, and nothing in the kernel ever set it. Every request went out at
  the model's default, which reads as "this model ignores effort" rather than
  "nobody plumbed it through".

  `AgentRunConfig` gains `effort`, a sibling of `thinking` rather than a field
  inside it — on some models the two are independent controls that apply together,
  and nesting would make that combination unsayable. It is run-level rather than
  per-step because the provider documents that changing effort between requests
  does not preserve a cached prefix, so a value that moves between steps buys a
  different answer shape at the cost of the cache on every step that changes it.

  **`thinking` turned out to have the same defect, and had shipped with it.** It
  was settable only through `drainQuery`. Every ergonomic entry point — `runAgent`,
  `ReactiveAgent`, `SupervisorAgent`, and the agent manager's bare-config branch —
  builds its run config by hand-listing fields, so a field nobody remembered to add
  is dropped in silence, with no cast to blame and no error to see. A caller could
  set `thinking` on an agent config and get a run that never asked for it. Both
  fields now live on `BaseAgentConfig` and are forwarded by all four.

  This was found by watching an actual HTTP body from a real run. The unit tests
  passed throughout, because they drive the kernel directly, and the kernel was
  never the half that was broken.

  **A driver that cannot honour `effort` now refuses rather than dropping it**,
  the rule `thinking` already had. Effort is the worse silence of the two: a
  dropped `thinking` leaves an empty reasoning list someone might notice, while a
  dropped `effort` leaves a perfectly ordinary answer, so a run requested at `max`
  is indistinguishable from one at the default — including in what it cost.
  Nothing existing breaks, because the field could not be set until now.

  Two driver-side corrections ride along, both verified against the live wire:

  - The preview model's capability row claimed all five effort levels. It takes
    `max` and not `xhigh`. That model is not reachable from the tenant the live
    suite runs against, so the row is sourced from the reference rather than
    measured — but the pairing itself is now measured, on a model that has it:
    `claude-sonnet-4-6` answers `xhigh` with _"This model does not support effort
    level 'xhigh'. Supported levels: high, low, max, medium"_ and accepts `max`.
    Reading the levels as a ladder, where anything taking the top rung takes the
    one below, is what produced the wrong row.
  - `output_config` is now merged rather than assigned. It is a shared envelope on
    that wire — a structured-output format and a task budget live in it too — so
    assigning meant whoever wired the next one would silently delete effort, or
    have effort delete theirs, depending only on which line ran last.

## 3.0.0

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

### Patch Changes

- f8355de: reasoning effort is dropped only on the models that actually refuse it

  With thinking switched off, the driver discarded `xhigh` and `max` on every
  model that can switch thinking off. The reasoning was that the pairing is
  incoherent anyway — asking a model not to think and then to think as hard as
  possible.

  Measured against the live API, the rule was too wide. One model family rejects
  that combination with _"effort is not supported when thinking is disabled"_;
  its siblings accept it and honour the effort. So the blanket rule was silently
  discarding a setting the caller asked for and the wire would have applied, on
  models where nothing was wrong.

  Looking incoherent is not the same as being rejected, and only the wire decides
  which. The capability table now carries the levels accepted with thinking off
  as a separate set from the levels accepted generally, because on most models
  those two sets are identical and on one family they are not.

## 2.0.1

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

- f25ebce: an effort level a model does not have is no longer sent

  `ThinkingCapability.effort` was a boolean — "does this model take an effort
  hint?" — and that was never the question. The ceiling moved twice: `xhigh`
  arrived with 4.7, and `max` does not exist below 4.6. The accepted levels are a
  **set**, and a flag could not say that `xhigh` is rejected on a 4.6 or that
  `max` is rejected on a 4.5.

  While it was a flag, both of those went to the wire, and the vendor rejects an
  unknown level rather than clamping it — so a caller who set `effort: 'xhigh'`
  and pointed at a 4.6 got a failed request, not a slightly different answer.

  The driver now checks the level against the model:

  | model                                     | accepted levels                     |
  | ----------------------------------------- | ----------------------------------- |
  | 4.7 and later, and the always-on families | `low` `medium` `high` `xhigh` `max` |
  | 4.6                                       | `low` `medium` `high` `max`         |
  | Opus 4.5                                  | `low` `medium` `high`               |
  | everything else                           | none                                |

  A level the model does not have is dropped rather than refused: `effort` shapes
  an answer the model will still produce, so a request without it is the same
  request at the model's own default — whereas refusing would fail a call that
  has a correct answer. The existing rule about disabled thinking at `xhigh`/`max`
  is unchanged.

  `patch`, not `minor` or `major`: `ThinkingCapability` is internal to this
  package. The entry point exports `registerAnthropic`, `AnthropicProvider`,
  `ANTHROPIC_CAPABILITIES` and two config types, and the changed field is
  reachable from none of them — so no consumer's code compiles differently. What
  a consumer sees is only that a request that used to fail now succeeds.

  The capability table's tests now cover every currently-served model with its
  level set, plus the dated-id shape that previously parsed a release date as a
  minor version.

- f25ebce: the edit tool's schema could not be sent under strict validation

  Strict tool input is not "JSON Schema, enforced" — it is a **subset** of JSON
  Schema, and a keyword outside that subset is not degraded. The vendor rejects
  the whole request, so one unexpressible field in one tool takes every other
  tool down with it and the turn dies before producing a token.

  The `edit` tool declared its integer-or-`"end"` field with `oneOf`, which is
  outside the subset while the equivalent `anyOf` is inside it. Measured against
  the live API:

  | body                      | result                                           |
  | ------------------------- | ------------------------------------------------ |
  | `strict: true` + `oneOf`  | **400** — `Schema type 'oneOf' is not supported` |
  | `strict: false` + `oneOf` | accepted                                         |
  | `strict: true` + `anyOf`  | accepted                                         |

  The middle row is why nothing caught it. Neither half is wrong on its own — the
  schema is valid JSON Schema, and marking the tool strict is correct policy — so
  no test of either one failed. Only the pairing did, and the pairing had no
  owner. Every agent using the built-in `edit` tool on a model at or above the
  strict gate lost its first tool-carrying turn to a 400.

  `oneOf` is now `anyOf` (equivalent here — the branches are disjoint), and
  `minimum` is gone from the model-facing schema for the same reason: numeric
  bounds are outside the subset too. The bound is not lost, the execution schema
  still enforces it.

  **The general fix is the second half.** `assertStrictSchema` and
  `findStrictSchemaViolations` are exported from `@namzu/sdk`, and the driver now
  checks every schema it is about to mark strict — refusing with the exact path
  and the remedy rather than letting the request go and getting back an error
  that names the keyword but not where it lives:

  ```
  Tool "edit" is marked for strict input validation, but its model-facing schema
  uses 1 construct(s) the strict subset does not accept…
    edit.properties.insertLine.oneOf — use `anyOf` — for disjoint branches the two are equivalent
  ```

  A test sweeps every built-in tool that asks for strict validation, so the next
  one is caught in the suite rather than in production.

## 2.0.0

### Major Changes

- 1cd1094: Thinking is now resolved per model, `effort` is sendable, and thinking tokens
  are reported.

  **Thinking on a current model was a failed request, not a degraded one.** The
  driver mapped `type: 'enabled'` straight to the wire and everything else to
  `disabled`. The vendor rejects a mismatched mode with a 400 rather than
  falling back: `thinking.type.enabled` is refused from Claude 4.7 onward,
  `adaptive` is refused on 4.5 and earlier, and the always-on models refuse
  `disabled`. One body for every model does not compromise quality, it fails.

  `ThinkingConfig.type` gains `'adaptive'`, and the Anthropic driver resolves the
  declared intent against the model it is about to call — sending the mode that
  model accepts, dropping a budget where budgets have no meaning, and omitting
  the field entirely rather than asking an always-on model to stop thinking. An
  unrecognised model is treated as manual-only, which is the previous behaviour
  and keeps a gateway serving an older model working.

  **`ThinkingConfig.display` is narrowed to `'summarized' | 'omitted'`**, and now
  actually reaches the wire. It was `'full' | 'summarized'`: `'full'` is not a
  value any vendor accepts — a declared option that could only ever have been
  rejected — and `'omitted'` was missing. It also was not serialized at all,
  which matters more than it sounds: `display` defaults to `'omitted'` on newer
  models, so a caller wanting to show reasoning received thinking blocks with
  empty text and nothing to explain why.

  **`effort` is new on `ChatCompletionParams`** — `'low' | 'medium' | 'high' |
'xhigh' | 'max'`. It goes out as `output_config.effort`, a _sibling_ of
  `thinking` rather than a field inside it, because it shapes the whole response
  and one manual-mode model accepts it alongside a token budget; nesting it would
  have made that combination unsayable. It is dropped on models that do not
  accept it, and refused in the one combination the vendor rejects — thinking
  disabled at `xhigh`/`max`.

  **`TokenUsage.reasoningTokens`** carries `output_tokens_details.thinking_tokens`
  when the vendor reports it. It is a _subset_ of `completionTokens`, not an
  addition — reasoning is billed as output, so summing it into a total would
  double-count. Absent means not reported, never zero: coercing would claim every
  turn on every silent driver did no thinking, and streamed events carry the
  breakdown only on the final delta.

  **Migration.** `display: 'full'` no longer compiles — use `'summarized'`, which
  is what it meant. Code passing `thinking: { type: 'enabled', budgetTokens }`
  keeps working and is now translated per model instead of rejected by newer
  ones. `assertThinkingSupported` in `@namzu/openai` refuses `'adaptive'` as it
  already refused `'enabled'`, since that driver implements neither.

  Not changed: a report accompanying this work claimed `temperature`, `top_p` and
  `top_k` are rejected on 5-series models and should be dropped by the driver.
  The Messages reference, the extended-thinking page and the thinking
  troubleshooting page document no such restriction, so nothing was implemented —
  silently dropping sampling parameters that would have worked is its own defect.

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
