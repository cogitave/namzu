---
'@namzu/sdk': minor
---

`coalesce` and its `CoalesceOptions` are now exported from the package root. It merges consecutive `text_delta` and `tool_input_delta` events inside a sliding window, so a slow consumer — typically an SSE route writing to a browser — writes fewer, larger frames instead of one per token.

It was written, tested and reachable by nothing: no in-tree caller, absent from every public entry, its only reader its own test file. Exported rather than deleted because the consumer it was written for is out of process by construction. The kernel emits raw deltas and has no UI and no hosted service, so deciding how often to write to a slow client is the host's policy — only the host knows what is on the other end of its socket. `bridge/sse/` maps an event onto the wire; this decides the rate.

The module header now also states what `streaming/` owns: coalescing, and nothing else. SSE mapping is `bridge/sse/`, provider chunk assembly is in the driver packages, and the run event stream is `runtime/query/`.
