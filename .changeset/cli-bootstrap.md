---
'@namzu/cli': patch
---

**M0 — CLI Bootstrap** (`ses_001-cli-bootstrap`)

Turn `packages/cli` from a single-command stub into an extensible command shell. No new user-visible feature beyond what already shipped (`doctor` behavior is unchanged); every later milestone (M1–M7) now has a place to plug in.

- **Command framework:** Commander.js wires subcommand routing, `--help`, `--version`. Each command is a `CommandDef` (name, description, optional passThrough, handler) registered through a thin adapter, so swapping the framework later is a one-file change.
- **Doctor preserved:** the legacy `runDoctorCommand(args)` signature and its `--json`/`--category`/etc. flags are forwarded unparsed (`passThrough: true`); the doctor JSON shape and exit codes are unchanged.
- **Output formatters:** new `--format <text|json|yaml>` and `--quiet` global flags. Stubs print structured payloads through a `Formatter` (text/json/yaml). Doctor keeps its own `--json` for now.
- **Config cascade:** `loadConfig()` resolves CLI flags > `NAMZU_*` env > `./namzu.config.json` > `~/.namzu/config.yaml` > defaults. Schema is intentionally minimal (`format`, `quiet`) — milestones populate it as concrete settings land.
- **Stub commands:** `chat` (M3), `tools` (M1), `providers` (M2), `skills` (M5), `serve` (M7) — each prints its milestone marker through the active formatter and exits 0.
- **Tests:** `runCli`, formatter factory, and config cascade are covered; pre-M0 `doctor` tests are untouched and still pass.

Exit codes follow sysexits: `0` OK, `1` doctor checks failed, `2` no config, `64` `EX_USAGE` (Commander parse errors), `70` `EX_SOFTWARE` (internal CLI error / doctor's pre-existing unknown-option path).

New library exports: `runCli`, `registerAll`, `registerCommand`, `createFormatter`, `loadConfig`, `DEFAULT_CONFIG`, and the `CommandDef` / `CommandContext` / `Formatter` / `NamzuCliConfig` types.
