---
title: Telemetry
description: Configure tracing and metrics in @namzu/sdk with TelemetryProvider, OTLP or console exporters, and the built-in platform metrics helpers.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# Telemetry

The SDK exports a small but useful observability surface. It can bootstrap OpenTelemetry, expose shared tracers and meters, and provide a ready-made metrics helper for common Namzu runtime measurements.

## 1. The Public Telemetry Surface

The main exports are:

| Export | Purpose |
| --- | --- |
| `TelemetryProvider` | Explicit telemetry lifecycle owner |
| `initTelemetry()` | Create and store the global telemetry provider |
| `getTelemetry()` | Read the current global telemetry provider |
| `getTracer()` | Get the tracer used by runtime internals and your own code |
| `getMeter()` | Get the shared meter used by metrics helpers |
| `createPlatformMetrics()` | Record common Namzu runtime metrics |

## 2. Bootstrap Telemetry

`initTelemetry()` creates the global provider, but you still need to start it:

```ts
import { initTelemetry, createPlatformMetrics } from '@namzu/sdk'

const telemetry = initTelemetry({
  serviceName: 'docs-runtime',
  serviceVersion: '1.0.0',
  exporterType: 'console',
})

await telemetry.start()

const metrics = createPlatformMetrics()
metrics.recordToolCall('read_file', true)

await telemetry.shutdown()
```

This is the safest application pattern:

1. initialize once during app startup
2. start the provider before traffic begins
3. shut it down during graceful termination

## 3. Exporter Types

`TelemetryConfig.exporterType` supports:

| Value | Behavior |
| --- | --- |
| `console` | Emit spans and metrics to console exporters |
| `otlp` | Export through OTLP HTTP exporters |
| `none` | Disable exporter startup while keeping the API surface available |

For OTLP:

```ts
const telemetry = initTelemetry({
  serviceName: 'docs-runtime',
  exporterType: 'otlp',
  otlpEndpoint: 'https://otel.example.com',
  otlpHeaders: {
    Authorization: `Bearer ${process.env.OTEL_TOKEN!}`,
  },
  metricExportIntervalMs: 10_000,
})

await telemetry.start()
```

## 4. What Happens If You Never Initialize Telemetry

The helper accessors are intentionally forgiving:

- `getTelemetry()` returns `null`
- `getTracer()` falls back to a default `namzu` tracer
- `getMeter()` falls back to a default `namzu` meter

That means SDK code can keep calling tracing or metrics helpers safely, but you should not expect useful exports until you initialize and start a provider.

## 5. Built-In Platform Metrics

`createPlatformMetrics()` returns a small metrics facade:

```ts
const metrics = createPlatformMetrics()

metrics.recordTokenUsage('gpt-4o-mini', 1200, 240)
metrics.recordToolCall('grep', true)
metrics.recordRunDuration('completed', 3.2)
metrics.recordLLMLatency('gpt-4o-mini', 0.84)
```

Those methods cover four common operational signals:

- token usage
- tool-call success or failure
- run duration
- LLM latency

## 6. Add Custom Spans

You can use the shared tracer for your own instrumentation:

```ts
import { getTracer } from '@namzu/sdk'

const tracer = getTracer()
const span = tracer.startSpan('docs.custom.operation')

try {
  // your work here
} finally {
  span.end()
}
```

This is useful when your application adds orchestration logic around Namzu but still wants all spans under one telemetry setup.

## 7. Span Naming Helpers

The SDK also exports small helpers for consistent span names:

- `agentRunSpanName(agentName)`
- `agentIterationSpanName(iteration)`
- `chatSpanName(model)`
- `toolSpanName(toolName)`

Use them when your custom instrumentation should align visually with the SDK's own traces.

## 8. What the SDK Already Instruments

Even without custom spans, the runtime already uses the shared tracer in core execution paths such as:

- agent run setup
- iteration execution
- tool execution

That means telemetry becomes more valuable as soon as you initialize the provider globally.

## 9. Common Mistakes

| Mistake | Why it hurts |
| --- | --- |
| calling `initTelemetry()` but never `start()` | the provider exists, but exporters are not started |
| expecting `getTelemetry()` to always return a provider | it returns `null` until initialization happens |
| using custom spans with a different telemetry bootstrap than the runtime | traces become fragmented across providers |
| assuming metrics export without a started provider | fallback meters keep code safe, but they do not replace real exporter startup |

## Related

- [SDK Runtime](../runtime/README.md)
- [Low-Level Runtime](../runtime/low-level.md)
- [Event Bridges](../integrations/event-bridges.md)
- [Safety and Operations](../architecture/safety.md)
- [Telemetry Setup Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/provider/telemetry/setup.ts)
- [Metrics Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/telemetry/metrics.ts)
