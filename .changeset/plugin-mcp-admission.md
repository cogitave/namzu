---
'@namzu/sdk': major
'@namzu/cli': major
---

Plugin MCP server declarations now reject fields they do not implement, including `url`, `headers`, `inheritEnv` and `requireApproval`. Those fields were previously accepted and silently removed while the declared stdio command still started. Remove unsupported fields from `plugin.json` or an in-code plugin; configure a remote server through the host's MCP settings and express approval in host source permissions. Plugin MCP startup now has a ten-second deadline across connection and discovery, configurable with `connectTimeoutMs` up to one hour, and cleans up a failed connection before rolling back the plugin.
