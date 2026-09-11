---
"@namzu/sdk": patch
---

Prevent runs with `maxToolCalls` from failing before tool execution when ledger recovery overlaps a durable event append. Runtime ledger reads now share the event writer's queue, waiting for earlier writes and preventing later writes from overlapping the read. Malformed or incomplete persisted records are still rejected; tool-call limits and reservation accounting are unchanged.
