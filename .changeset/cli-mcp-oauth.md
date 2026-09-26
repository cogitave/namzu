---
"@namzu/cli": minor
---

Add `namzu mcp login <name>` and `namzu mcp logout <name>` for configured HTTP tool servers. Login uses the official MCP OAuth authorization-code flow, a loopback or pasted callback, PKCE, callback state and authorization-server issuer checks. The CLI stores the resulting Bearer and refresh tokens privately for that exact server URL. Ordinary tool calls reuse or refresh the saved grant without opening a browser; a configured Authorization header continues to take precedence. HTTP authorization refusals stop connection setup instead of falling back to a legacy handshake.
