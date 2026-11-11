---
'@namzu/sdk': minor
'@namzu/cli': minor
---

An MCP tool call that reports progress can now outlive `requestTimeoutMs`, as an opt-in. New `MCPClientConfig.resetTimeoutOnProgress` (and the same key per server in `namzu.config.json`, `~/.namzu/config.yaml` and `.mcp.json`): when `true`, each progress report whose value rose restarts the request deadline for that call, so a server that works for a minute and reports throughout is no longer cut off at 30 seconds. New `maxTotalTimeoutMs` is the most such a call may take in total, counted from when it was issued and never extended; it defaults to ten times `requestTimeoutMs` (5 minutes at the default 30 seconds) and may not be below `requestTimeoutMs`. A call that stops reporting fails after `requestTimeoutMs` of silence, and one that never stops fails at the cap; the error says which. Nothing changes unless `resetTimeoutOnProgress` is set. `MCPClient` now throws at construction for a `maxTotalTimeoutMs` that is not an integer from 1 to 2,147,483,647 or is below `requestTimeoutMs`, even when the option is off; a CLI server with such a value fails by name.
