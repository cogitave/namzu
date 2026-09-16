---
"@namzu/sdk": major
---

`MCPClient.connect()` now negotiates across four legacy MCP protocol revisions — `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` — instead of only `2024-11-05`. It offers `2025-11-25` (the newest) in a single `initialize` request and accepts whatever the server answers with, as long as the answer is one of the four; a server negotiating to anything else is refused, naming the version offered, the version answered, and the full supported list. This is one round trip, never a per-version retry loop.

**This is the changed default that makes the release major:** the version this client advertises in `initialize` moves from `2024-11-05` to `2025-11-25`. A server that tailors its response to the client's claimed version — richer content blocks, a different capability set — now sees a different value on the wire, and (for a server negotiating to `2025-06-18` or `2025-11-25`) now also receives an `MCP-Protocol-Version` header on every request after `initialize`, which it did not receive before. There is no per-call way to pin the old advertised version or suppress the new header: a caller that needs the previous behavior stays on the previous major version of `@namzu/sdk`.

New on the public surface, both additive: the `McpEra` type (`{ kind: 'modern'; version } | { kind: 'legacy'; version }` — only `legacy` is reachable today) and `MCPClient.getEra()`, which returns the era the last `connect()` negotiated, or `undefined` before one has. `MCPTransportSendOptions` gains an optional `headers` field.

See [MCP protocol eras](../docs/sdk/mcp-protocol-eras.md) for the full model, why there is no waterfall, and what this workstream deliberately does not build yet (the 2026-07-28 "modern" era).
