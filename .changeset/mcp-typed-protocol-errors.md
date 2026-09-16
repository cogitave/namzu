---
"@namzu/sdk": minor
---

An MCP tool or connection failure that came back as a JSON-RPC error reply now rejects with a new exported `MCPProtocolError` (a subclass of `Error`) carrying the reply's numeric `code` and its `data` payload untouched, instead of only a formatted string. Three narrow predicates — `isUnsupportedProtocolVersionError`, `isMissingRequiredClientCapabilityError`, `isHeaderMismatchError` — let a caller react to a specific MCP error code without comparing magic numbers itself. A new `RESOURCE_NOT_FOUND_CODES` constant lists the JSON-RPC codes a server may use for "that resource doesn't exist."

Additive only: `error.message` still reads exactly `MCP error {code}: {message}` as before, so an existing `catch` block or a test matching on that string is unaffected, and `MCPProtocolError` is a subclass of `Error`, never a replacement for it. A malformed error reply (a missing or non-integer `code`) still rejects, with a distinctly-named local error that none of the three predicates match.
