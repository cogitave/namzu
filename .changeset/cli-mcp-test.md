---
'@namzu/cli': minor
---

Add `namzu mcp test <name>` to check the effective MCP server selected by the current profile and project. It connects only that server, reports the usable tool count or a safe failure reason, and closes the connection. The working directory must be trusted; pass `--trust` to accept it for this test only. After adding a server, run this command before starting an agent to find connection, authentication or tool discovery problems.
