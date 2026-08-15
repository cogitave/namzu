---
'@namzu/cli': minor
---

Stop silencing the CLI's own logger

Every one of `namzu run`, `namzu drain`, `namzu run-stream` (including its `providers-json` sibling) and the interactive TUI forced the SDK logger's level to `silent` on its way into a session, and nothing anywhere in the tree ever turned it back on. That is the whole, literal reason a boot problem, a skipped provider, or a discovery failure never showed up anywhere: not a missing feature, a standing instruction to throw every diagnostic away.

Each entry point now installs a real sink instead:

- `run`/`drain` write pretty-printed records to stderr by default; pass `--log-format json` (or set `NAMZU_LOG_FORMAT=json`) for NDJSON.
- `run-stream` (and `providers-json`) always write NDJSON to **stderr** — a machine-read channel distinct from stdout's own event protocol, which is untouched by any of this.
- The interactive TUI buffers into a ring buffer instead of writing at all (Ink owns the terminal), and flushes it to stderr on a clean exit or a crash.

New flags: `--verbose` (debug level) and `--log-format <pretty|json>`. The existing `-q`/`--quiet` now also raises the log floor to warn. New env vars: `NAMZU_LOG_LEVEL`, `NAMZU_LOG_FORMAT`. An explicit `--verbose`/`--quiet`/`--log-format` always wins over its environment-variable counterpart.

**Default stderr output changes from nothing to info-level records.** Anyone parsing a namzu subprocess's stderr and relying on it being empty should pass `--quiet` (or set `NAMZU_LOG_LEVEL=warn`) to restore the old behaviour; stdout — every command's actual protocol — is unaffected.
