---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Tool servers can now offer skills, per server, and it is off until you turn it on. Set `skills: true` on an `mcpServers` entry (for a server that declares the `io.modelcontextprotocol/skills` extension on the 2026-07-28 revision) and its skills appear as `server:skill` in the model's skill list, the `/` menu and the `skill` tool. A server's skill is read when used, checked against the size and digest the server listed, and shown to the model as the server's own text. It grants nothing: `allowed-tools`, hooks, shell, model, agent and effort in its frontmatter are ignored. A server's `deny` list and `Skill(server:name)` rules decide it, and a server with `requireApproval` offers none. `disableMcpSkills: true` in your own or the managed config file turns the whole feature off; a project file cannot set it. Nothing changes for a server you do not opt in.

SDK: new `MCPClientConfig.skills`, `MCPClient.listSkillPage()` and `getSkill()`, `isMethodNotFoundError()`, `validateMcpSkillEntry()`, `admitMcpSkillEntries()`, `nameMcpSkills()`, `McpSkillSource`, `loadMcpSkillBody()` and `mcpSkillMetadata()`. The extension is declared only when `skills` is `true`, so existing clients send exactly what they sent before.
