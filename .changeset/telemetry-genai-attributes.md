---
'@namzu/telemetry': minor
---

`TelemetryConfig` gains `genAiAttributes` (default `true`). With a `@namzu/sdk` that writes them, the kernel's spans carry the OpenTelemetry GenAI convention names (version 1.41.1) beside their own; set `genAiAttributes: false` to leave those names and the schema URL off, for a backend that bills by attribute. An older `@namzu/sdk` inside the peer range ignores the setting and writes none. Existing attribute names are untouched.
