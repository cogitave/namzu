---
'@namzu/sdk': major
'@namzu/cli': major
---

A stdio server is handed what it was granted, not everything the host holds

`StdioTransport` spawned its child with `{ ...process.env, ...config.env }`, so every connected server received every environment variable the host process had. Measured through the real transport: **119 variables on a developer machine, including a secret planted in the parent for the probe.** A server that needs one token was handed all of them, and nothing in its configuration said so — the grant was invisible because it was total.

The child now receives process plumbing (`PATH`, `HOME`/`USERPROFILE`, `SystemRoot`, `ComSpec`, `TEMP`, locale, and the rest of that kind), plus whatever the configuration names.

**What breaks.** A server that was reading a credential straight out of your environment stops finding it. That is the whole point of the change, and it will look like the server failing to authenticate rather than like a configuration change, so it is worth knowing before the upgrade rather than after.

**What to do.** Name what the server may have:

```toml
[mcpServers.issues]
command = "some-mcp-server"
inheritEnv = ["GITHUB_TOKEN"]
```

`inheritEnv` names variables to pass through from your own environment. Prefer it over `env` for anything secret — `env` writes the literal value into the config file, and this leaves the value where it already lives. A named variable the parent does not hold is absent from the child rather than empty, so a server's own `if (!token)` still works; it does not fail the spawn.

**Plugin-declared servers get no `inheritEnv`, deliberately.** A plugin that could name the host variables its server receives would be awarding itself a credential grant, which is not a plugin's to award. A plugin-declared server gets plumbing plus the literal `env` in its own manifest; if it needs a host credential, declare that server in `mcpServers` instead, where the operator is the one naming it.

The tests assert on the environment the child actually receives, driving a real spawn — not on whether the configuration was accepted. A test of the second kind passes against the version this replaces.
