---
'@namzu/sdk': major
'@namzu/cli': major
---

Plugin MCP server declarations now reject fields they do not implement, including `url`, `headers`, `inheritEnv` and `requireApproval`. Those fields were previously accepted and silently removed while the declared stdio command still started. Remove unsupported fields from `plugin.json` or an in-code plugin; configure a remote server through the host's MCP settings and express approval in host source permissions. Plugin MCP startup now has a ten-second deadline across connection and discovery, configurable with `connectTimeoutMs` up to one hour, and cleans up a failed connection before rolling back the plugin.

Hosts supplying `ConfigRegistry` must move plugin reconnect-policy overrides from `mcp.<server-name>` to `mcp.plugin.<plugin-name>.<server-name>`; the old key was shared by unrelated plugins and is no longer read. A `ConfigScope` now has `dispose()` to release its live namespace and watchers while retaining saved overrides. Plugin disable and failed enable release their scopes, and overlapping enable, disable and uninstall calls for one plugin id now settle in call order.

Plugin MCP drift is now tracked by full plugin source id rather than bare server name: hosts that relied on a drift event between two unrelated plugins using the same local server label should compare those sources explicitly. The baseline now follows the one admitted listing actually mounted as tools, including reconnect and list-change refreshes; a second startup listing is gone.
