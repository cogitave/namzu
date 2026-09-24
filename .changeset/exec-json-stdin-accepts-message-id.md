---
'@namzu/cli': minor
---

Stateless `namzu exec --json` history on stdin (`Message[]`, no `--session`) now accepts and keeps an optional `id` on each message (`BaseMessage.id`, `@namzu/sdk`'s new field), the same way it already keeps `toolCalls[].id`: validated as a string, never required, never stripped. A host that reads a prior turn back from `namzu history --session <key>` (which carries the real durable id on every message) can feed that same history into a later stateless call unmodified and have `query()` reconcile it by id. This stream's own `delta`/`tool-start`/`tool-end` events do not yet surface a message's id as it happens, so a host that only ever rebuilds `Message[]` from this stream still has none to attach — that keeps working exactly as before, reconciled by value.
