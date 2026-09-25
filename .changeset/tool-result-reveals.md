---
"@namzu/sdk": minor
---

Added `ToolResult.reveals?: readonly string[]`. A tool's own result can name further deferred tools to make callable — the same mechanism `search_tools` uses. The runtime persists admitted names on the tool message, so discovery survives later sends and resume until compaction. Unknown, already-active and out-of-allowlist names are ignored. There is no suspended state or mutable registry activation. See `docs/sdk/tool-discovery.md` for the migration from `ToolRegistry.activate()`.
