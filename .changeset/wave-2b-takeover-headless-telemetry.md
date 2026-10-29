---
"@namzu/cli": minor
"@namzu/telemetry": minor
---

Run headless `--no-session-persistence` turns against an in-memory session log instead of writing a conversation and deleting it later. A crash or signal no longer leaves that run's transcript behind. Resumed history is read without updating its source or creating a durable fork. Stateless JSON runs no longer open the persistent conversation store, and accept the flag explicitly; combining it with `--session` is refused so keyed history is not silently lost. Other project state and explicitly configured exports are unaffected.

Choose trace and metric exporters independently with `OTEL_TRACES_EXPORTER` and `OTEL_METRICS_EXPORTER`: `none` disables only that signal, and `console` redirects only that signal. Embedders can use the new optional `traceExporterType` and `metricExporterType` overrides; existing `exporterType` remains their fallback. Both pipelines drain on shutdown even when one fails. General and signal-specific OTLP protocol settings select the shipped `http/json` transport; unsupported `grpc` or `http/protobuf` requests are reported rather than silently substituted.
