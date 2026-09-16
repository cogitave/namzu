---
"@namzu/sdk": minor
---

`MCPClient` now protects `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` from a caller-supplied per-request header on **every** connection, including a 2024-11-05 or 2025-03-26 legacy session — the two eras that send none of their own headers, where the protection previously derived its refused set from the era's own header keys and so refused nothing. `Mcp-Method` and `Mcp-Name` are modern-only headers this client never writes on any legacy connection, so this closes the gap on every legacy era, not only the two oldest. A caller relying on setting one of these three by hand on a legacy connection will now have it silently dropped and warn-logged, matching the modern-era behavior this package already documented as universal.

New `isResourceNotFoundError(error)`, alongside the existing `isHeaderMismatchError`/`isUnsupportedProtocolVersionError`/`isMissingRequiredClientCapabilityError`, recognizing the two JSON-RPC codes a server may use for "that resource, prompt or tool does not exist" (`-32002`, current spec; `-32602`, an older server's application-defined equivalent) — the codes `RESOURCE_NOT_FOUND_CODES` already listed but nothing had consumed.

No wire-format or default-behavior change beyond the header fix above; both changes are exports/behavior a consumer only gains.
