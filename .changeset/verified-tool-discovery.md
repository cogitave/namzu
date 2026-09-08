---
"@namzu/sdk": minor
---

Make `search_tools` distinguish verified active matches from missing tools when deferred discovery finds nothing. Active results remain bounded and access-scoped, and an explicit empty tool allowlist no longer exposes or activates tools. Add `ToolRegistry.searchActive` with an optional structural interface method; custom registries without it receive an honest discovery limitation instead of an invented active-tool receipt.
