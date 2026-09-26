---
"@namzu/sdk": minor
---

`MCPClient.callTool` accepts `onProgress` and requests a unique MCP progress token per tool call. Concurrent calls receive only their own validated, bounded progress updates; callbacks stop on completion or cancellation. Streamable HTTP dispatches progress while the SSE response remains open and releases the reader as soon as the matching final reply arrives. MCP tools forward updates through `ToolContext.report` for live host and CLI status.
