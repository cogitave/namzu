---
'@namzu/cli': minor
---

**M1 — Clawtool default plugin** (`ses_002-clawtool-bridge`)

`namzu tools ls` (and `run`, and `sync-types`) now talk to the local clawtool daemon for real. Clawtool is consumed as a runtime dependency: the namzu CLI auto-detects the daemon, spawns it (`clawtool daemon start`) if missing, then proxies its tool catalog into the agent's tool surface via MCP over HTTP. No `@namzu/clawtool` package — adding a tool to clawtool means namzu sees it on next start with zero TS changes.

**New subcommands** under `namzu tools`:

- `ls` — list every tool clawtool exposes (auto-spawns the daemon if needed). Output is structured through the M0 formatter; `--format json|yaml` works.
- `run <name> --input <json>` — invoke a tool by name with JSON arguments and print the structured result. Exit 1 when the tool itself returns an error.
- `sync-types --output <dir>` — opt-in dev-time codegen. Shells out to `clawtool tools export-typescript` so editor autocomplete + type-checking can bind to clawtool's actual schema; refresh after upgrading clawtool.

**Internals** (`packages/cli/src/integrations/clawtool/`):

- `paths.ts` — XDG-aware lookup of `~/.config/clawtool/{daemon.json,listener-token}` (honors `$XDG_CONFIG_HOME`).
- `state.ts` — parses clawtool's atomic state file with strict shape validation.
- `auth.ts` — `readToken` (strict) + `tryReadToken` (lenient; returns null for `--no-auth` loopback daemons).
- `binary.ts` — PATH lookup + `clawtool.binary` config override; actionable error if missing.
- `daemon.ts` — `ensureDaemon()`: TS port of Go `daemon.Ensure(ctx)` with health-poll + auto-spawn (configurable via `clawtool.autoStart`).
- `client.ts` — bearer-auth HTTP wrapper (in-tree; minimal).
- `mcp.ts` — Streamable HTTP MCP client (`initialize` → `notifications/initialized` → `tools/list` / `tools/call`) with `Mcp-Session-Id` round-tripping and SSE single-event response parsing. We did **not** reuse `@namzu/sdk`'s `MCPClient` because its `http-sse` transport targets the older MCP HTTP+SSE spec, whereas clawtool serves the new Streamable HTTP — keeping this in-tree avoids spec drift.
- `plugin.ts` — `createClawtoolPlugin()`: discovers the catalog and returns proxy `ClawtoolProxyTool` objects with a `call(args)` dispatch.

**Config schema** extension: `NamzuCliConfig.clawtool?: { binary?, endpoint?, token?, autoStart? }`. All optional; zero-config defaults work out of the box.

**Tests**: 20 new unit cases (state file parsing, token reading with both strict + lenient variants, PATH lookup with executable detection, MCP client wire shape with mocked fetch including session-id capture / Bearer-omission for no-auth / Mcp-Name routing / error mapping). Total now 76/76 green (was 56). Live end-to-end smoke against a real clawtool 0.22.159 daemon validated `tools ls` (78 tools discovered), `tools run Bash` (real shell roundtrip), and `tools sync-types` (60+ stub files generated).

**Removed**: the M0 `tools` stub from `commands/stubs.ts`; replaced by the real `commands/tools.ts`.
