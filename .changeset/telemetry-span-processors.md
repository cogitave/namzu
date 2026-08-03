---
'@namzu/telemetry': minor
---

`registerTelemetry` accepts host-supplied span processors.

The tracing SDK used to let a host attach a processor to an already registered provider, and takes them only at construction now — so a host that wants its own export path (a test collector, a second destination, a redaction stage) had no way in at all. `spanProcessors` is that way in. They are installed ahead of whatever `exporterType` selects, so they still see spans under `exporterType: 'none'`, which suppresses the exporter rather than the pipeline.

This is what the consumer-install smoke fixture needed: it attaches an in-memory exporter to prove the span pipeline wires up end to end, and the call it used to make no longer exists.
