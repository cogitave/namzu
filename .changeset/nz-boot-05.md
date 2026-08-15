---
'@namzu/sdk': minor
'@namzu/cli': minor
---

Emit the CLI boot narrative — sandbox notice, provider chain, capability probe, config provenance and a terminal ready/refused event

**`@namzu/sdk`**: `EVENT_NAME_ATTRIBUTE` is now re-exported from the root barrel (`packages/sdk/src/utils/log/index.ts` was missing the value re-export that let it reach a host package). This is what lets a package outside the SDK — `@namzu/cli`, here — name a boot event without duplicating the reserved key `createLogger` promotes onto `LogRecord.eventName`.

**`@namzu/cli`**'s default stderr output changes from nothing to an info-level boot narrative on every invocation, not only `run`/`drain`/`run-stream`/the TUI — `namzu doctor`/`namzu login` now also print `namzu.boot.start` and `namzu.config.resolved` ahead of their own output, because `getContext()` is the one place any subcommand resolves logging + config. Use `--quiet` (LOG-05) to go back to warn-and-above; `NAMZU_LOG_LEVEL=silent` remains a full return to today's silence.

The highest-value line: `ResolvedSandbox.notice`/`.unconfined` (computed on every boot, discarded until now) are emitted as `namzu.sandbox.resolved`, at `warn` specifically when nothing is confined and `info` otherwise — an operator reading default output now sees "this platform enforces none of filesystem, network, process" instead of it existing only in a field nothing read.

Also new: `namzu.provider.resolved` (the constructed chain and each skipped fallback's reason), `namzu.capability.detected`/`.broken` (via `probeCapabilities`, gaining its first consumer and joining `@namzu/cli`'s public exports alongside the existing `probeOptionalPackage`/`CapabilityProbe`/`NAMZU_OPTIONAL_CAPABILITIES`), `namzu.discovery.completed` (MCP connectors — plugin/skill discovery is not yet wired to the boot path and is not claimed here), `namzu.telemetry.status` (states plainly that no `TracerProvider`/`LoggerProvider` is registered, since the CLI does not call `registerTelemetry()` on any path today), and the terminal `namzu.boot.ready` / `namzu.boot.refused` pair — `ready` fires exactly once on success with no boolean readiness field, `refused` fires at `error` on every early return out of `createAgentSession` including a `sandbox.requireIsolation` control this host cannot meet, which now also logs before the process exits non-zero (the exit code itself is unchanged — the existing top-level catch in `runCli` already produced it).

The two previously-silent `catch {}` blocks in `packages/cli/src/tui/agent.ts` (a failed provider-client rebuild after an OAuth token refresh; a sub-agent runtime that failed to start) now each emit one `warn` record with `exception.type`/`exception.message`. Neither's behavior changed — both remain non-fatal.

No exported signature changed and no default changed; every addition is either a new export or new stderr output governed by the existing `--quiet`/`--verbose`/`NAMZU_LOG_LEVEL`/`NAMZU_LOG_FORMAT` controls.
