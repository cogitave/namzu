# @namzu/telemetry

## 2.0.0

### Major Changes

- 935b8f3: Lift the dependency floor to versions without published advisories

  Eighty-two open advisories collapsed to a handful of real decisions, because most of them were the same package reached through one path.

  The telemetry exporters carried a serialization library with twenty-four advisories against it, two of them critical. The exporters move from the 0.57 line to 0.221, and the stable packages beside them from 1.x to 2.x — a major bump for this package, since a consumer pinning the older peers must move with it.

  The two vendor driver SDKs move to their current releases, closing the advisories that came with them.

  The test runner accounted for fourteen critical advisories on its own. It is a development dependency and never reaches a published artifact, but it runs in CI against the repository's own contents, so it moves to the first patched release rather than being waved through as out-of-scope.

### Minor Changes

- 935b8f3: Retry works on a wrapped error, and the runtime actually emits metrics.

  **Every error signal is now read across the whole cause chain.** It was read
  off the error handed in, so one layer of wrapping hid it — and wrapping is
  the normal case, not an edge one: a vendor SDK wraps its transport error and
  the runtime wraps again on the way out. A rate limit wrapped **once**
  classified as `unknown`, which is treated as non-retryable, so the retry
  policy was dead for every failure that was not the outermost throwable. A
  socket reset two levels down was likewise unknown — the one class of failure
  where retrying is almost always right.

  Status, transport errno, `Retry-After`, and message text are all searched
  along the chain now, outermost first, with a `seen` set so a cause cycle
  (easy to build by accident when errors are re-wrapped in a retry loop)
  terminates instead of hanging. Precedence is unchanged — status, then errno,
  then message — and an unwrapped error classifies exactly as before.

  **The runtime emitted spans and not one measurement.** Metrics lived in a
  bag a host was expected to construct, and nothing in the workspace ever
  constructed one. Worse, the bag bound its instruments eagerly, so one built
  before `registerTelemetry()` captured the no-op meter and discarded every
  write for the rest of its life — silently, forever, from a line of call
  order.

  - The instruments now live beside the code that records them, and the
    runtime records token usage and model latency per call, tool outcomes per
    call, and run duration per run.
  - Instruments resolve **lazily** and re-resolve when a real provider is
    installed, so registration order no longer decides whether anything is
    measured.
  - One token metric split by `gen_ai.token.type`, not two under two names
    with the second invented — a dashboard aggregating the conventional name
    was getting input tokens only and under-reporting usage by roughly half.
  - Cache reads and writes are recorded as their own token types. They bill
    differently, so a total that hides them cannot explain a bill.
  - Tool calls carry an error type, so a broken tool can be told apart from
    one whose input the model keeps getting wrong.
  - `createPlatformMetrics()` still works and now delegates to the same
    instruments, so host and runtime measurements aggregate instead of
    describing the same events under two names.

- 935b8f3: `registerTelemetry` accepts host-supplied span processors.

  The tracing SDK used to let a host attach a processor to an already registered provider, and takes them only at construction now — so a host that wants its own export path (a test collector, a second destination, a redaction stage) had no way in at all. `spanProcessors` is that way in. They are installed ahead of whatever `exporterType` selects, so they still see spans under `exporterType: 'none'`, which suppresses the exporter rather than the pipeline.

  This is what the consumer-install smoke fixture needed: it attaches an in-memory exporter to prove the span pipeline wires up end to end, and the call it used to make no longer exists.

### Patch Changes

- 935b8f3: Retire the declarations that promised behaviour nothing implemented, and implement the ones worth keeping.

  Seven fields were declared on exported types and read by nothing. Each was a contract a host could satisfy and get no result from — the worst kind of gap, because the only signal is that nothing happens.

  **Implemented**

  - `maxToolContentBytes` capped the rich channel of a tool result, and no caller could set it: `ToolingBootstrapConfig` had no such field, so the cap was always `0` and the capping branch was unreachable. It is now settable on `ReactiveAgentConfig` and on query params, and reaches the executor through the same chain `maxToolOutputChars` already had.
  - `AdvisoryResult.warnings` and `.decisions` had two consumers each — the advisory phase folds decisions into working state so they survive compaction, and renders warnings back to the executing agent — and no producer at all. Advisors are now told the convention their answer is read with, and `parseAdvisoryResponse` lifts `<warnings>` / `<decisions>` blocks out of the prose. The contract is appended to a host-written prompt and a persona-assembled one too, not only the default; an advisor never told the convention would have had its warnings silently discarded.
  - `AdvisoryBudget.maxCostPerRun` is enforced before each call against real accumulated spend, and `maxTokensPerCall` clamps the advisor's own response ceiling. Cost is now computed from a new optional `AdvisorDefinition.pricing`, and a run that sets a cost cap over unpriced advisors is **refused at construction** rather than left with a cap that could never be reached.

  **Removed** — declared, never read, and not worth building:

  - `AdvisoryBudget.maxCallsPerSession` and `maxCostPerSession`: the advisory stack is built once per run, so no accumulator outlived one and a per-session cap could only ever be decoration. `maxCostPerCall` went with them — a per-call cap can only be checked after the spend, which is a log line, not a budget.
  - `AdvisoryResult.plan`, `.modelSuggestion`, `.toolGuidance`: no producer and no consumer.
  - `ToolsetDefinition.toolPolicies`: stored on the toolset and never consulted, so a per-tool `{ enabled: false }` override was inert.
  - `SandboxConfig.cleanupOnDestroy`: defaulted to `true` and read by nothing; `destroy()` removes unconditionally either way.
  - `StructuredOutputConfig.enforceToolChoice`: documented a tool-choice mechanism no code implemented.
  - `RuntimeConfig.promptCache`: caching is unconditional at both model calls, and no surface accepts a `RuntimeConfig`, so nothing could set it even in principle.

  Also ports the telemetry provider to the current tracing API — `Resource` became a type with a factory, and span processors moved to the provider constructor — and lifts a run deadline inside the long-document flow test that aborted the run at 5s and read as a broken flow rather than a busy machine.

- 935b8f3: Four places where namzu knew something and told no one.

  **A backoff is now visible.** `withProviderRetry` logged and slept. There
  was no run event, no wire event, and — worse than that — the sole
  production call site never passed a logger, and every warn in the decorator
  is guarded behind it, so the log lines were dead code too. A run could sit
  silent for the better part of a minute between `iteration_started` and the
  next event, or up to the 60s server-directed cap, with no signal and no
  keepalive: a backoff was indistinguishable from a hang, and a host's
  watchdog would cancel a run that was about to succeed.

  A `provider_retry` run event now carries the attempt, the ceiling, the
  delay, the classified code and whether the server asked for it, mapped to
  `provider.retry` on the SSE wire and to a `running` status update over A2A.
  It is emitted **before** the sleep, so the delay it names is still ahead —
  which is also why it rides the stream as a delta-less chunk rather than an
  out-of-band callback: the consumer is blocked inside the provider's
  iterator, so a callback could not reach it until the wait was already over.
  The omission was never principled; `tool_progress` exists to answer "is it
  still working?" and the wire contract justifies the reasoning events on
  exactly the same grounds.

  **Two latency measurements that could not be recovered from the data.**
  `gen_ai.client.time_to_first_token` is recorded at the first delta of any
  kind. namzu streams, so perceived latency is dominated by that number, and
  the one existing latency histogram measures the whole request — it cannot
  tell a fast-first-token long generation from a stalled one, and no host
  could reconstruct the difference in any form.
  `gen_ai.tool.call.duration` records what the executor has measured since
  its first version: the value was already in scope one frame above the call
  site, emitted per call on `tool_completed`, and had no instrument. It
  carries the same attributes as the tool-call counter, so "which tool is
  slow" and "which tool fails" are one query rather than two that cannot be
  joined.

  **`run_failed` carries the classification it always had.** The event was a
  bare string, and the run boundary flattened the throwable into it,
  discarding `code`, `status`, `retryAfterMs`, `retryable`, `details` and the
  cause chain. This was never a missing taxonomy: the provider-boundary
  classifier already walks all of that, so a fully-populated error arrived at
  the boundary and was thrown away one line later — and `toPlatformError`,
  the projection written for exactly this, had no callers outside its own
  test. `run_failed` now carries `failure` alongside `error`; the A2A bridge
  sends it as event metadata (a peer deciding whether to retry needs the
  flag, not prose to pattern-match) and the CLI prefixes the code. Nothing
  had to change at the hundreds of `throw` sites.

  Not fixed, and worth naming: the advisory `on_error` trigger still
  substring-matches. Its input is tool output from the message history, which
  has no structured code to preserve — that needs a tool-side error catalog,
  not this change.

  **The published attribute constants can no longer drift.**
  `@namzu/telemetry/attributes` restated the attribute bags by hand and had
  already lost `GENAI.TOKEN_TYPE`, the dimension that splits the token
  counter by kind. The consequence was narrow — namzu emits through the
  canonical module, so the dimension is on the data regardless — but this is
  the entry point the observability docs steer consumers to, the package had
  no tests at all, and the public-surface verifier only loads the SDK bundle.
  It is now a re-export, with a parity test so a future hand-copy fails
  immediately.

## 1.0.1

### Patch Changes

- b776acf: Make the package-version read bundle-safe. `version.ts` read `../package.json`
  via `createRequire(import.meta.url)` at module-init with no guard. esbuild leaves
  `createRequire` calls as runtime requires and collapses the dist tree into a
  single file, so in a bundle `../package.json` no longer resolves and the read
  threw at import time — crashing the whole process on any code path that touches
  the SDK runtime (`Cannot find module '../package.json'`). Wrap the read in
  try/catch with a `0.0.0` fallback, mirroring the CLI's existing
  `readPackageVersion`. Unbundled behaviour is unchanged (real version is read);
  a bundled build degrades the cosmetic version string instead of crashing.

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

## 0.1.1

### Patch Changes

- c9b180d: Coordinated patch bump across all publishable packages after the `@namzu/telemetry@0.1.0` extraction landed. No functional changes — this is a compatibility and release-pipeline validation cut to (a) exercise the Trusted Publisher binding for `@namzu/telemetry` that was configured after the 0.1.0 bootstrap publish, and (b) give consumers a single aligned set of patch versions that all know about the new telemetry package.

  Resulting versions:

  - `@namzu/sdk` → `0.4.1`
  - `@namzu/telemetry` → `0.1.1`
  - `@namzu/computer-use` → `0.2.1`
  - `@namzu/anthropic`, `@namzu/bedrock`, `@namzu/http`, `@namzu/lmstudio`, `@namzu/ollama`, `@namzu/openai`, `@namzu/openrouter` → `0.1.2`

## 0.1.0

### Minor Changes

- 96e3f84: Initial publish. OpenTelemetry exporter pipeline extracted from `@namzu/sdk@0.3.x` so consumers who don't emit telemetry no longer transitively install the OTEL Node SDK.

  Exports:

  - `registerTelemetry(config): Promise<TelemetryProvider>` — **async**. Awaits `TelemetryProvider.start()` and mutates `@opentelemetry/api`'s global TracerProvider and MeterProvider before resolving.
  - `TelemetryProvider` — class moved verbatim from `@namzu/sdk`.
  - `getTelemetry`, `getTracer`, `getMeter` — thin readers over the api globals.
  - `createPlatformMetrics` + `PlatformMetrics` — common runtime metric counters.
  - `TelemetryConfig`, `ExporterType` — types.
  - `@namzu/telemetry/attributes` subpath — `GENAI` + `NAMZU` constant bags, span-name helpers (`agentRunSpanName`, `agentIterationSpanName`, `chatSpanName`, `toolSpanName`).

  Peer dependencies: `@namzu/sdk >=0.4.0 <1.0.0`, `@opentelemetry/api ^1.9.0`.

  Ships with `exporterType: 'console' | 'otlp' | 'none'`. Datadog/Honeycomb/Lightstep and any third-party OTEL exporters are not bundled; install them directly alongside `@namzu/telemetry`.

  `withTelemetry(provider)` (provider-call wrapping) is **not** shipped in this release and is the scope of a follow-up session. Provider packages' "forthcoming `@namzu/telemetry`" README copy remains truthful — the package exists, the wrapper lands later.

  See [`docs/migration/0.4.md`](https://github.com/cogitave/namzu/blob/main/docs/migration/0.4.md).
