---
title: Telemetry
description: Configure tracing and metrics with @namzu/telemetry — OTLP or console exporters, and the built-in platform metrics helpers.
last_updated: 2026-04-20
status: current
related_packages: ["@namzu/telemetry", "@namzu/sdk"]
---

# Telemetry

As of `0.4.0`, the OpenTelemetry exporter pipeline ships in a separate
package: [`@namzu/telemetry`](https://www.npmjs.com/package/@namzu/telemetry).
`@namzu/sdk` depends only on `@opentelemetry/api` (peer). Consumers who
never emit telemetry no longer transitively install the full OTEL Node
SDK. See [`docs/migration/0.4.md`](../../migration/0.4.md) if you are
upgrading from `0.3.x`.

## 1. Install

```
pnpm add @namzu/telemetry @opentelemetry/api
```

`@opentelemetry/api` is a peer of both `@namzu/sdk` and `@namzu/telemetry`.
On pnpm 9+ and npm 7+ it auto-installs; on older clients, install it
explicitly yourself.

## 2. The Public Telemetry Surface

All telemetry exports come from `@namzu/telemetry` (not `@namzu/sdk`).

| Export | Purpose |
| --- | --- |
| `TelemetryProvider` | Explicit telemetry lifecycle owner |
| `registerTelemetry()` | **async** — create the global provider and start it |
| `getTelemetry()` | Read the current global provider |
| `getTracer()` | Get the shared tracer |
| `getMeter()` | Get the shared meter |
| `createPlatformMetrics()` | Record common Namzu runtime metrics |

Types: `TelemetryConfig`, `ExporterType`, `PlatformMetrics`.

Attribute constants (`GENAI`, `NAMZU`) and span-name helpers
(`agentRunSpanName`, `agentIterationSpanName`, `chatSpanName`,
`toolSpanName`) ship under the subpath:

```ts
import { GENAI, NAMZU, toolSpanName } from '@namzu/telemetry/attributes'
```

## 3. Bootstrap Telemetry

`registerTelemetry()` is asynchronous. It must be awaited — the underlying
`TelemetryProvider.start()` returns a `Promise<void>` because the OTEL
Node SDK attaches its exporters asynchronously. Firing-and-forgetting
would detach startup failures into an unhandled rejection.

```ts
import { registerTelemetry, createPlatformMetrics } from '@namzu/telemetry'

const telemetry = await registerTelemetry({
  serviceName: 'docs-runtime',
  serviceVersion: '1.0.0',
  exporterType: 'console',
})

const metrics = createPlatformMetrics()
metrics.recordToolCall('read_file', true)

// ... application work ...

await telemetry.shutdown()
```

Safe application pattern:

1. initialize once during app startup, `await` completion
2. construct `createPlatformMetrics()` AFTER `registerTelemetry` resolves
3. shut down during graceful termination

## 4. Exporter Types

`TelemetryConfig.exporterType`:

| Value | Behavior |
| --- | --- |
| `console` | Emit spans and metrics to console exporters |
| `otlp` | Export through OTLP HTTP exporters |
| `none` | Disable exporter startup while keeping the API surface available |

OTLP:

```ts
const telemetry = await registerTelemetry({
  serviceName: 'docs-runtime',
  exporterType: 'otlp',
  otlpEndpoint: 'https://otel.example.com',
  otlpHeaders: {
    Authorization: `Bearer ${process.env.OTEL_TOKEN!}`,
  },
  metricExportIntervalMs: 10_000,
})
```

## 5. What Happens If You Never Call `registerTelemetry`

The helper accessors are intentionally forgiving:

- `getTelemetry()` returns `null`
- `getTracer()` falls back to the `@opentelemetry/api` no-op tracer
- `getMeter()` falls back to the `@opentelemetry/api` no-op meter

That means SDK code can keep calling tracing or metrics helpers safely,
but spans and metric writes are silently discarded until a real provider
is registered. This is the standard OpenTelemetry library contract, not a
Namzu quirk.

## 6. Eager-Bind Caveat for `createPlatformMetrics`

`createPlatformMetrics()` builds counters and histograms at construction
time against whatever `getMeter()` returns. If you construct it *before*
`registerTelemetry()`, the counters bind to the no-op meter and every
subsequent `.add()` / `.record()` is discarded — for the lifetime of
that metrics instance. Registering a real provider later does *not*
retroactively rewire existing counters.

**Always** `await registerTelemetry({...})` first, then
`createPlatformMetrics()`. Or wrap the latter in a lazy factory if the
call order is not under your control.

## 7. Built-In Platform Metrics

```ts
const metrics = createPlatformMetrics()

metrics.recordTokenUsage('gpt-4o-mini', 1200, 240)
metrics.recordToolCall('grep', true)
metrics.recordRunDuration('completed', 3.2)
metrics.recordLLMLatency('gpt-4o-mini', 0.84)
```

Four common operational signals: token usage, tool-call success/failure,
run duration, LLM latency.

## 8. Add Custom Spans

```ts
import { getTracer } from '@namzu/telemetry'

const tracer = getTracer()
const span = tracer.startSpan('docs.custom.operation')

try {
  // your work here
} finally {
  span.end()
}
```

## 9. What the SDK Already Instruments

Even without custom spans, the SDK runtime already uses the shared
tracer in core execution paths:

- agent run setup (`runtime/query/index.ts`)
- iteration execution (`runtime/query/iteration/index.ts`)
- tool execution (`registry/tool/execute.ts`)

Telemetry becomes useful as soon as you `await registerTelemetry()` at
startup; nothing else in your code needs to change to pick up the
instrumentation already there.

## 10. Common Mistakes

| Mistake | Why it hurts |
| --- | --- |
| calling `registerTelemetry()` without `await` | startup errors silently become unhandled rejections |
| constructing `createPlatformMetrics()` before `registerTelemetry` | counters bind to the no-op meter and never rewire |
| expecting `getTelemetry()` to always return a provider | it returns `null` until registration completes |
| using custom spans with a different telemetry bootstrap than the SDK | traces fragment across providers |

## Related

- [`@namzu/telemetry` on npm](https://www.npmjs.com/package/@namzu/telemetry)
- [Migration guide for 0.4.0](../../migration/0.4.md)
- [SDK Runtime](../runtime/README.md)
- [Low-Level Runtime](../runtime/low-level.md)
- [Event Bridges](../integrations/event-bridges.md)
- [Safety and Operations](../architecture/safety.md)
