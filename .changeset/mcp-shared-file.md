---
"@namzu/cli": minor
---

A project's `.mcp.json` is now read as shared tool servers, in the `{ "mcpServers": { ... } }` shape. It is read exactly when `namzu.config.json` is, after you have trusted the folder, so nothing in it starts before you approve the folder; a server that `namzu.config.json` also names keeps the config entry. `namzu exec` (and `exec --json`) also takes `--mcp-config <file>`, repeatable, to add servers for one run; a missing file stops the run with a usage error. Nothing to change unless you already have a `.mcp.json` in a project you trust: its servers will now start, so review it first.
