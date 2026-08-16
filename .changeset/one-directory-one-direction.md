---
'@namzu/sdk': patch
---

Internal move: `connector/mcp/server.ts` and `connector/mcp/server-stdio.ts` now live in `connector/mcp/server/`, behind a barrel that states the rule the directory encodes. No exported name, signature or behaviour changes, and no import path a consumer writes changes — `connector/mcp/index.ts` re-exports the same names from the new location.

Everything else under `connector/mcp/` is this process calling somebody else's MCP server. These two are the reverse: somebody else's client calling ours. They were siblings distinguished only by the word `server` in two filenames out of twelve, in a directory where every other name is also about a server — the one being called. `MCPServerToolProvider` is something a host implements to expose its own tools; `MCPServerId` two files over identifies a remote server this process connects to.
