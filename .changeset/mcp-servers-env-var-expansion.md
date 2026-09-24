---
"@namzu/cli": minor
---

`mcpServers` entries in `namzu.config.json` may now reference the operator's own environment from inside an `env` or `headers` value with a bare `${VAR_NAME}` (identifier characters only — no `${VAR:-default}` fallback). This is narrower than the interpolation some other MCP clients' configs use: only `env` and `headers` values are expanded (never `command`, `args`, `url` or `cwd`), and a reference to a variable that is not set fails that one server with a named reason instead of substituting an empty string. `inheritEnv` remains the primary way to grant a named variable to a stdio child under its own name; `${VAR_NAME}` is for the value itself, and is the only secret-safe option `headers` has ever had.

Purely additive: a config with no `${...}` in its `env`/`headers` values behaves exactly as before. A config that happened to contain a literal `${SOMENAME}` string matching a variable name that is set in the operator's environment now has that string substituted rather than passed through literally.
