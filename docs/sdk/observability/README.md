---
title: Telemetry
description: Configure tracing and metrics with @namzu/telemetry — OTLP or console exporters, and the built-in platform metrics helpers.
last_updated: 2026-08-03
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

```ts sketch
import { GENAI, NAMZU, toolSpanName } from '@namzu/telemetry/attributes'
```

`GENAI` and `NAMZU` are **re-exported** from `@namzu/sdk`, not restated —
they used to be a hand-maintained copy here and had already drifted, losing
`GENAI.TOKEN_TYPE`. A parity test now fails if anyone copies them back.

### Metrics the runtime records

| Instrument | Kind | What it answers |
| --- | --- | --- |
| `gen_ai.client.token.usage` | counter | tokens, split by `gen_ai.token.type` (`input` / `output` / `cache_read` / `cache_write`) |
| `gen_ai.client.operation.duration` | histogram | how long a whole model request took |
| `gen_ai.client.time_to_first_token` | histogram | how long the caller waited before anything arrived |
| `gen_ai.tool.call.count` | counter | tool calls, by name / success / error type |
| `gen_ai.tool.call.duration` | histogram | how long a tool took, same attributes as the count |
| `namzu.run.duration` | histogram | how long a run took, by how it settled |

Time-to-first-token and request duration are deliberately separate.
namzu streams, so perceived latency is dominated by the first number, and
the second cannot distinguish a fast-first-token long generation from a
stalled one. Tool duration carries the same attributes as the tool count so
"which tool is slow" and "which tool fails" are one query, not two that
cannot be joined.

## 3. Bootstrap Telemetry

`registerTelemetry()` is asynchronous. It must be awaited — the underlying
`TelemetryProvider.start()` returns a `Promise<void>` because the OTEL
Node SDK attaches its exporters asynchronously. Firing-and-forgetting
would detach startup failures into an unhandled rejection.

```ts sketch
import { registerTelemetry, createPlatformMetrics } from '@namzu/telemetry'

const telemetry = await registerTelemetry({
  serviceName: 'docs-runtime',
  serviceVersion: '1.0.0',
  exporterType: 'console',
})

const metrics = createPlatformMetrics()
metrics.recordToolCall('Read', true)

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

```ts sketch
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

```ts sketch
const metrics = createPlatformMetrics()

metrics.recordTokenUsage('gpt-4o-mini', 1200, 240)
metrics.recordToolCall('Grep', true)
metrics.recordRunDuration('completed', 3.2)
metrics.recordLLMLatency('gpt-4o-mini', 0.84)
```

Four common operational signals: token usage, tool-call success/failure,
run duration, LLM latency.

## 8. Add Custom Spans

```ts sketch
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
tracer in core execution paths, and emits them as a **nested hierarchy**
matching the OpenTelemetry GenAI semantic conventions:

```
invoke_agent {agent}          runtime/query/index.ts
└── namzu.agent.iteration N   runtime/query/iteration/index.ts
    ├── chat {model}          runtime/query/iteration/stream-turn.ts
    └── namzu.tool.execute X  registry/tool/execute.ts
```

The `chat` span carries `gen_ai.operation.name`, the request and response
model, `gen_ai.response.finish_reasons`, token usage and the cache
read/write counters — so LLM latency and per-call token attribution land
where vendor GenAI dashboards look for them.

Telemetry becomes useful as soon as you `await registerTelemetry()` at
startup; nothing else in your code needs to change to pick up the
instrumentation already there.

> **Implementation note for contributors.** Span parents are threaded
> explicitly (`parentContext(span)`), never through the ambient context.
> Every span-owning body in the run loop is an async generator, and a
> generator resumes on its *consumer's* async context — so
> `startActiveSpan` compiles, runs, and silently parents nothing. Before
> this was fixed, a 20-iteration run emitted 21 disconnected root spans.

## 10. Common Mistakes

| Mistake | Why it hurts |
| --- | --- |
| calling `registerTelemetry()` without `await` | startup errors silently become unhandled rejections |
| constructing `createPlatformMetrics()` before `registerTelemetry` | counters bind to the no-op meter and never rewire |
| expecting `getTelemetry()` to always return a provider | it returns `null` until registration completes |
| using custom spans with a different telemetry bootstrap than the SDK | traces fragment across providers |
| creating a child span with `startActiveSpan` inside an async generator | the ambient parent is gone by the time the body resumes, so the span emits as a root — pass the parent explicitly |

## Related

- [`@namzu/telemetry` on npm](https://www.npmjs.com/package/@namzu/telemetry)
- [Migration guide for 0.4.0](../../migration/0.4.md)
- [SDK Runtime](../runtime/README.md)
- [Low-Level Runtime](../runtime/low-level.md)
- [Event Bridges](../integrations/event-bridges.md)
- [Safety and Operations](../architecture/safety.md)
