---
"@namzu/sdk": patch
"@namzu/cli": patch
---

Shipped prose no longer names other named products. `matchesToolSelector`'s doc comment (`packages/sdk/src/tools/roster.ts`) and [Tool metadata and selectors](../docs/sdk/tool-metadata-and-selectors.md) describe its synchronous-only design against "some other agent frameworks' equivalent selector" instead of one by name; [Tool servers](../docs/cli/mcp-servers.md) describes the wider `${VAR}`/`${VAR:-default}` interpolation some MCP clients accept as "several desktop and editor MCP clients" instead of naming two. Wording only: no type, default or behaviour changed.
