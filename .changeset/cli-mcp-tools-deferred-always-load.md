---
'@namzu/cli': major
---

Every MCP server's tools are now offered by name only and loaded with `search_tools` before the model calls one. Before, they were deferred only when all servers' definitions together reached 10% of the turn's context window, and sent in full otherwise; that size rule is removed. To keep a server's tools sent in full, as before, set `alwaysLoad: true` on its `mcpServers` entry (new optional key, default `false`; anything but a boolean fails that server by name). A tool the model loaded stays loaded after compaction, and a server that connects mid-turn is announced by name. See `docs/cli/mcp-servers.md`.
