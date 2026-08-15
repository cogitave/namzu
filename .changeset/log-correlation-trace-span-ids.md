---
'@namzu/sdk': minor
---

`LogRecord` gains `traceId`, `spanId` and `traceFlags`, resolved from the active OTel span at emit time

`createLogger`'s `emit` now reads `telemetry/runtime-accessors.ts`'s new `getActiveSpanContext()` — `trace.getSpan(context.active())?.spanContext()` — for every accepted record, and stamps `traceId`/`spanId`/`traceFlags` onto it when a span is active. All three arrive together or not at all: a trace id with no span id would be a half-address, worse than the plain absence a reader can already tell apart from "unwritten".

Resolved PER RECORD, never once at `createLogger` construction — a logger built before a tracer provider registers still picks up spans started after registration.

With no tracer provider registered, or a real one registered with no context manager to carry it past the first `await` (`@opentelemetry/api`'s default `NoopContextManager`), the three fields are simply absent from the record — not `''`, not `'unknown'`, and nothing throws. Reading the active context can only ever ADD information to a record; it cannot make a host that never configured telemetry fail anything it did not already fail.

New optional fields only. No existing `LogRecord` consumer breaks, and a sink reading unknown keys is unaffected.
