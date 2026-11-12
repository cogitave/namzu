---
'@namzu/sdk': minor
---

The MCP client now uses more of the 2026-07-28 revision. Nothing you call changes shape, and a server of an older revision is sent what it was before, with two exceptions below. To keep the old behaviour of anything here, see the notes.

- New `MCPClient.subscribeResource(uri)` and `unsubscribeResource(uri)` ask a server for one resource's updates (`resourceSubscriptions` on the listen stream, `resources/subscribe` on older servers). The client never subscribed to a resource before.
- Tool, prompt, resource and template lists and resource reads are now kept for the `ttlMs` a 2026-07-28 server sends (scoped by `cacheScope`, dropped on a change notification). Before, every call went to the server. A server that sends no `ttlMs`, and every older server, is fetched each time as before.
- A tool call a 2026-07-28 server turns into a task (tasks extension) is now polled to its result inside the existing deadline rules, reports progress through `onProgress`, and is cancelled with `tasks/cancel` when the call is (a `tasks/get` in flight is abandoned with its own `notifications/cancelled`). The client declares the extension only to a server that advertises it; the new `MCPClientConfig.tasks: false` declares nothing. New `extensions` on `MCPClientCapabilities` and `MCPServerCapabilities`, new `MCP_TASKS_EXTENSION` export.
- Requests on a 2026-07-28 connection carry `traceparent` (and `tracestate`) in `_meta` when a span is active, and nothing when it is not.
- On a 2026-07-28 server `listTools()` returns tools sorted by name, so a model's prompt cache does not break when a server lists in a different order. A server of an older revision keeps the order it sent. A `ping` from a server of 2025-11-25 or older is now answered with an empty result (before, method-not-found).
- Not built: a task that asks for input (`input_required`) is cancelled and the call fails with `MCPInputRequiredError`, instead of the client answering through `tasks/update`.
