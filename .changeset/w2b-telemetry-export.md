---
'@namzu/cli': minor
---

Namzu can now send its spans and metrics to an OpenTelemetry collector. It is off unless you ask: set `NAMZU_ENABLE_TELEMETRY=1` (the standard `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` choose where) or add a `telemetry.otlp` block with `endpoint` and `headers` to a config file. Spans carry timings, counts and names, plus the conversation id and the error text of a failed tool call, which can contain a command line or a file path; no prompt or reply is attached. Nothing changes for anyone who sets neither.
