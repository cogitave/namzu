---
"@namzu/sdk": minor
---

Add an optional `durableInbound` source to query, runAgent and query-backed
agent configuration. Deliveries use ordinary session-log message records and
await both their append queue and the host's exact acknowledgement before
inference. An explicit sessionLog is required for this optional source.

Export durable claim/reference/receipt contracts and bounded reference
validation. Runtime context can retain an optional delivery reference without
acquiring operator authority. Existing initial input, synchronous queues and
outstanding-work holds retain their defaults.
