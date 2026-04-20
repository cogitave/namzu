# @namzu/telemetry

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
