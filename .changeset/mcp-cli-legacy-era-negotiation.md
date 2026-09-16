---
"@namzu/cli": minor
---

The CLI's MCP client connections now negotiate against a broader set of legacy MCP protocol revisions (via `@namzu/sdk`'s `MCPClient`), so an MCP server that had negotiated to `2025-03-26`, `2025-06-18` or `2025-11-25` — refused outright before this release — now connects normally. No CLI-owned config key, flag or default changes; this is an operator-visible improvement (more MCP servers connect) delivered through the SDK dependency bump, not a change to anything the CLI itself declares as its own surface. Minor rather than major on that basis.
