---
"@namzu/sdk": minor
---

`MCPClient` now understands MRTR's `resultType` envelope on a `tools/call` result: absent or `"complete"` is unchanged from before, `"input_required"` is read as `{ inputRequests?, requestState? }`, and any other value is refused (the spec's own "MUST be considered invalid") through the new `MCPInvalidResultTypeError` rather than being passed through as an ordinary result.

**Automatic recovery, once.** A `requestState`-only `InputRequiredResult` — the only shape a conforming server can send, since `namzu` declares `clientCapabilities: {}` and MRTR rule 7 forbids asking for anything else — is retried immediately, echoing `requestState` byte-for-byte under a fresh JSON-RPC id. `requestState` itself is opaque: never parsed, inspected or logged in full.

**A typed, catchable outcome for everything else.** An `InputRequiredResult` carrying `inputRequests` this client cannot satisfy, a second `input_required` after the one retry, or a `-32021 MissingRequiredClientCapability` error — the failure a no-capability host is actually likely to see — no longer reach a tool call's caller as an unexplained rejection. `mcpToolToToolDefinition`'s `execute` catches all three and returns a `ToolResult` with `success: false` and a `data.code` of `mcp_tool_input_required` (naming the requested method(s) in `data.requested`) or `mcp_tool_missing_client_capability` (naming `data.requiredCapabilities`), both `retrySafety: 'safe'`. Both still pass through the existing untrusted-content framing before reaching a model.

New on the public surface: `decodeResult`, `MCPDecodedResult`, `MCPInputRequest`, `MCPInputRequiredError`, `MCPInvalidResultTypeError`. Nothing existing changes shape — a legacy result with no `resultType`, which is every result a pre-MRTR server has ever sent, decodes exactly as it always has, and `MCPClient.callTool`'s own throw behaviour for an ordinary transport or protocol error is untouched.

See [MCP protocol eras](../docs/sdk/mcp-protocol-eras.md#mrtr-resulttype-and-a-typed-input_required-outcome) for the full design and why a conforming server can only ever ask for a retry, never for input this client has no way to give it.
