---
"@namzu/cli": major
"@namzu/sdk": patch
---

CLI MCP tool names change from `mcp_<server>_<tool>` to `mcp__<server>__<tool>`. Update any permissions, saved prompts or integrations that refer to those names. MCP tools now update after server notifications and reconnects. Configure `allow`, `deny`, `maxRetries`, `requireApproval`, `readOnlyHintTrusted` and `instructions` per server under `mcpServers`; `instructions: true` includes the server's text as labelled untrusted request context. `/mcp tools` shows the server's current tool names and instructions.

The SDK now skips prompt discovery when a server did not advertise prompt support and keeps approval-wrapped tool definitions stable across unchanged toolset snapshots.
