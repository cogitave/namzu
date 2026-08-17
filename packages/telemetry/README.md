<!-- okf
type: Reference
title: "@namzu/telemetry"
description: >-
  The OpenTelemetry exporter pipeline for @namzu/sdk. Installs a real tracer
  and meter provider on the OTel API globals, exports OTLP traces and metrics,
  and carries the session-export listener. Separate from the kernel so a
  consumer who emits nothing installs nothing.
tags: [readme, package, telemetry, opentelemetry]
timestamp: 2026-08-17T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/telemetry</h1>

**The OpenTelemetry pipeline for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk).**

[![License: FSL-1.1-MIT](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)
[![npm](https://img.shields.io/npm/v/@namzu/telemetry.svg?label=%40namzu%2Ftelemetry)](https://www.npmjs.com/package/@namzu/telemetry)

[Install](#install) · [Register it](#register-it) · [Exporters](#exporters) · [Session export](#session-export) · [Attributes](#attributes)

</div>

---

## What this is

`@namzu/sdk` depends on `@opentelemetry/api` only — the interface, not the
implementation. Without an implementation installed, that API's no-op defaults
discard every span and every metric write, silently and by design.

This package is the implementation. One call installs a real
`NodeTracerProvider` and `MeterProvider` on the OTel globals, wires OTLP
exporters for traces and metrics, and stamps `service.name` /
`service.version` on both.

It is a separate package so that a consumer who never emits telemetry does not
transitively install the OTel Node SDK — six packages they would carry to use
none of them.

## Install

```bash
pnpm add @namzu/telemetry @opentelemetry/api
```

Both `@namzu/sdk` (>=1.0.0) and `@opentelemetry/api` (^1.9.0) are peer
dependencies. `@opentelemetry/api` must resolve to **one** physical module for
the whole process — two copies means two global registries, and spans created
through one never reach the exporter installed on the other. The repository's
pre-publish check asserts that `require.resolve('@opentelemetry/api')` from
`@namzu/sdk` and from `@namzu/telemetry` return the same path.

## Register it

```ts
import { registerTelemetry } from '@namzu/telemetry'

await registerTelemetry({
  serviceName: 'my-agent-host',
  exporterType: 'otlp',
  otlpEndpoint: 'http://localhost:4318',
})
```

Call it once, at process startup, before anything creates a span or acquires a
meter. **Await it** — `start()` configures both pipelines asynchronously, and
firing and forgetting detaches a startup failure into an unhandled rejection.

It mutates the `@opentelemetry/api` globals rather than handing you an object
to thread around. That is the OTel library/application pattern, not dependency
injection, and it is why one call at the top is enough for the kernel's own
spans to reach your collector.

## Exporters

| `exporterType` | Traces | Metrics |
|---|---|---|
| `'otlp'` | OTLP/HTTP to `otlpEndpoint` + `/v1/traces` | OTLP/HTTP to `otlpEndpoint` + `/v1/metrics` |
| `'console'` | `ConsoleSpanExporter` | `ConsoleMetricExporter` |
| `'none'` | nothing exported | nothing exported |

**`'none'` still installs a real provider.** It suppresses the exporter, not
the pipeline: spans get valid trace and span ids — which is what makes a
`trace_id` on a log record join to anything — and any span processor you passed
in `spanProcessors` keeps receiving them. Only the batch exporter is left out.

```ts
await registerTelemetry({
  serviceName: 'my-agent-host',
  exporterType: 'none',
  spanProcessors: [myOwnCollector],   // still receives every span
})
```

| Option | Default | Notes |
|---|---|---|
| `serviceName` | — | required; becomes `service.name` |
| `serviceVersion` | this package's version | becomes `service.version` |
| `otlpEndpoint` | exporter default | `/v1/traces` and `/v1/metrics` are appended |
| `otlpHeaders` | — | e.g. an auth header for a hosted collector |
| `metricExportIntervalMs` | `10_000` | periodic reader interval |
| `spanProcessors` | — | installed ahead of the exporter's, under every `exporterType` |

`shutdown()` flushes and closes both providers. It never throws: it runs on the
way out of a process, and turning a telemetry problem into a non-zero exit for
a run that succeeded is the wrong trade. A failure is reported on stderr.

## Metrics

`createPlatformMetrics()` returns a handle onto the runtime's own instruments —
token usage, tool outcomes, run duration, model latency. It delegates rather
than defining its own, so what a host records lands on the same series as the
kernel's and the two aggregate instead of describing one event under two names.

```ts
import { createPlatformMetrics } from '@namzu/telemetry'

const metrics = createPlatformMetrics()
metrics.recordRunDuration('completed', 12.5)   // seconds
metrics.recordTokenUsage('a-model', 1200, 340)
```

The instruments resolve on first use, not at construction, so the order of
`createPlatformMetrics()` and `registerTelemetry()` does not matter.

## Session export

A durable, redacted record of what a session did, for a warehouse rather than a
tracing backend.

```ts
import { createSessionExportListener } from '@namzu/telemetry'

const listener = createSessionExportListener({
  sink: myWarehouseSink,
  redactor: secretRedactor,
})
```

`secretRedactor` is exported for use as-is: it drops the content-bearing fields
named by `CONTENT_BEARING_EVENT_TYPES`. `describeSessionExport(config)` returns
a sentence saying what would leave the process under a given configuration —
`namzu doctor` prints it, so an operator can read the answer instead of
inferring it from the config.

## Attributes

```ts
import { GENAI, NAMZU, agentRunSpanName } from '@namzu/telemetry/attributes'
```

The attribute keys and span names the kernel emits, exported so a dashboard or
a processor can name them once instead of re-typing string literals that drift.
`GENAI` holds the OTel GenAI semantic-convention keys; `NAMZU` holds this
kernel's own, all namespaced `namzu.*`.

## License

FSL-1.1-MIT, converting to MIT two years after each release. Same as
`@namzu/sdk`.
