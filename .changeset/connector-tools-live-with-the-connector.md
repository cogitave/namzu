---
'@namzu/sdk': patch
---

Internal directory move: `src/bridge/tools/connector/` is now `src/connector/tools/`. No exported name, signature or behaviour changes — every affected symbol is re-exported from the package root exactly as before.

`bridge/` is protocol boundaries: `bridge/a2a/`, `bridge/mcp/` and `bridge/sse/` each speak a wire format to something outside the process. The connector tool adapter speaks no protocol; it turns a connector's methods into tool definitions, which is connector work. It sat under `bridge/` because it is adjacent to MCP, not because it belongs to a boundary, and `bridge/tools/` had no second occupant to justify the level.
