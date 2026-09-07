---
"@namzu/ag-ui": minor
---

Add the optional `@namzu/ag-ui` package for exposing a trusted Namzu query
configuration through AG-UI typed events or a Fetch-compatible POST/SSE
endpoint. Hosts resolve authenticated native scope and explicitly admit
message history; backend tools, request-owned state updates, custom events,
authoritative final results, usage, cancellation, and bounded payloads are
supported with the official AG-UI 0.0.59 client.

Frontend tool definitions and AG-UI resume requests are rejected with HTTP
422. Native pauses report a custom event and a run error; checkpoint
resumption and durable thread history remain application responsibilities.
