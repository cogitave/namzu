---
"@namzu/sdk": minor
---

Added `ToolResult.reveals?: readonly string[]`. A tool's own result can now name further tools to activate for the rest of the turn — the same activation `search_tools` performs, offered to any tool. Only a name currently `deferred` in the registry, and inside `ToolContext.allowedTools` when the turn is narrowed, is activated; an unknown, already-active, out-of-allowlist or suspended name is silently ignored. Purely additive; nothing existing reads or sets this field today.
