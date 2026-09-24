---
"@namzu/sdk": major
"@namzu/cli": major
---

Plugin tools now carry a source for their owning plugin (`plugin:<name>`) or MCP server (`plugin:<name>/mcp:<server>`), so source authorization can distinguish them. Plugin MCP servers use `mcpToolset`, gaining live tool and prompt discovery, policy-filtered deferred resources and held changed definitions. Plugin MCP prompt tool names change from `<plugin>__mcp_prompt_<server>_<name>` to `<plugin>__mcp__<server>__prompt__<name>`; update saved tool names and permission rules that refer to them. `MCPToolsetOptions.reconnect` also accepts a function that returns the current reconnect policy.
