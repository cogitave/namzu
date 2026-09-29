---
'@namzu/cli': patch
---

Malformed `mcpServers` entries with invalid `args`, `env`, `headers`, `inheritEnv`, command, URL or working-directory types now fail by server name. One bad entry no longer aborts a session or prevents earlier successful connections from being closed.
