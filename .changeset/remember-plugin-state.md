---
"@namzu/cli": minor
---

The `/plugins` menu can now explicitly remember a plugin's enabled or disabled state across restarts and model switches. Session-only controls keep their existing behavior. A remembered disabled plugin remains visible without importing its executable modules or starting its MCP servers. Choices belong to the plugin's canonical directory and name, so another project's same-named plugin is unaffected. Settings are stored privately in `NAMZU_HOME/plugin-settings`; loading configuration and project trust still apply.
