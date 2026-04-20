---
"@namzu/telemetry": minor
---

Initial publish. OpenTelemetry exporter pipeline extracted from `@namzu/sdk@0.3.x` so consumers who don't emit telemetry no longer transitively install the OTEL Node SDK.

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
