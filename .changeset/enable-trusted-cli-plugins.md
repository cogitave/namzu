---
"@namzu/cli": minor
---

Add a default-off `plugins` configuration for trusted project and user plugin
discovery. Enabled CLI sessions now install SDK plugin tools, hooks, skills and
stdio MCP servers across interactive, headless, durable-resume and ACP entry
points, and own rollback and teardown of those contributions. Plugin authority
must come from a config file; environment-selected profiles cannot enable it.
