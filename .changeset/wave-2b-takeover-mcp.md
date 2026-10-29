---
"@namzu/cli": major
---

Add interactive `/mcp prompts`, `/mcp prompt <server> <name> [argument=value ...]`, `/mcp resources`, and `/mcp resource <server> <uri>` using the connected server registry. Required, unknown and duplicate prompt arguments are rejected before prompt execution. Server text is attached as labelled untrusted context, never interpreted as another slash command or file mention. Server allow/deny lists and the session's source/tool/input permission rules apply to discovery and reads; explicit asks still require review, including in bypass mode. Servers configured with `requireApproval` remain available only through their reviewed model tools, not these direct attachment paths.

MCP results are now bounded instead of forwarding unlimited text, data and rich content. Large results are truncated with a notice, and their secondary payloads are omitted. This changes the previous unbounded default, including large image or structured results; ask the server for a smaller result or split the work rather than relying on a complete oversized payload. Resource/prompt text attachments have a 30,000-character body budget before provenance framing. Add per-server `requestTimeoutMs` to control individual MCP round trips; leaving it unset preserves the SDK's 30-second deadline. Existing tool deferral behavior is unchanged.
