---
"@namzu/sdk": minor
---

Two additive changes to the MCP connector, both opt-in and default-preserving:

- `MCPInitializeResult.instructions` and `MCPClientState.serverInstructions` capture the server's `initialize` instructions string (legacy handshake only — the modern era has no `initialize` round trip and never populates this field). This is observability only: nothing folds it into an agent's instruction set automatically, matching namzu's existing rule that server-authored text never reaches instruction/system position unframed. A host that wants to display or log a server's instructions can read `client.getState().serverInstructions`.
- `mcpToolToToolDefinition` takes a new optional 5th parameter, `maxRetries?: number`. Left unset, behaviour is unchanged: no `maxRetries` on the returned `ToolDefinition`. When set, the adapter also now marks `ToolResult.retryable: true` on the two failures it already classifies as not having reached the server's side effect (`mcp_tool_input_required`, `mcp_tool_missing_client_capability`) — the field the executor's retry gate actually reads. An HTTP-redirect outcome-unknown failure and any raw transport error stay non-retryable, since whether either one reached the server is exactly what is not known.

Nothing to change for an existing caller: both are new optional fields/parameters with no effect until set.
