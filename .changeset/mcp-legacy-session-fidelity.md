---
"@namzu/sdk": minor
---

Legacy (2025-03-26 through 2025-11-25) Streamable HTTP connections now match three things those revisions specify and namzu did not do: a session that the server has forgotten answers `404`, and the client re-initializes once before retrying; `close()` sends a best-effort `DELETE` to tell a cooperative server the session is done; and an SSE event's `id:` field is captured and offered back as `Last-Event-ID` on the request after a reconnect, so a server that supports resumption can replay whatever this client may have missed.

All three are additive behavior on legacy connections only. A modern (2026-07-28) connection never establishes a session in the first place — it has nothing to re-initialize, nothing to `DELETE`, and nothing to resume — so it is unaffected structurally, not by an opt-out. The zero-config request shape for every existing caller is unchanged.

New on the public surface: `StreamableHttpTransport.resetSession()` and `.hasSession()`. `parseSseMessages`/`MCPSseParseResult` are also now exported from `connector/mcp/streamable-http.ts` for direct testing, but that module has no subpath in the package's `exports` map, so this is not reachable from outside the package and is not a public-surface change.
