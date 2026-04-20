# @namzu/telemetry

OpenTelemetry exporter pipeline for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk).

Extracted from `@namzu/sdk` in `0.4.0`. The SDK depends only on `@opentelemetry/api` (peer); this package ships the application-tier OTEL stack — `sdk-node`, `sdk-metrics`, `sdk-trace-node`, OTLP exporters, `resources`, `semantic-conventions` — behind a one-call `registerTelemetry()` entrypoint.

## Install

```
pnpm add @namzu/telemetry @opentelemetry/api
```

## Status

Scaffold — source lands with `0.4.0`. See [`docs/migration/0.4.md`](https://github.com/cogitave/namzu/blob/main/docs/migration/0.4.md) for the migration path from `@namzu/sdk`'s prior telemetry surface.
