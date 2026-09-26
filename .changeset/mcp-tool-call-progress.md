---
"@namzu/sdk": minor
---

`MCPClient.callTool` accepts `onProgress` and requests a unique MCP progress token per tool call. Concurrent calls receive only their own validated, bounded progress updates; callbacks stop on completion or cancellation. MCP tools also forward these updates through `ToolContext.report` for live host and CLI status.
