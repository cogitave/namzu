---
'@namzu/sdk': patch
---

Doctor registry runtime + 5 built-in checks — ses_007 Phase 4.

`runDoctor(opts?)` aggregates registered checks into a `DoctorReport` with per-check status + summary + sysexits exit code. `registerDoctorCheck(check)` is the programmatic registration entry point.

**New runtime exports (12 names):**

- `doctor` (singleton `DoctorRegistry`), `DoctorRegistry`, `createDoctorRegistry`
- `registerDoctorCheck(check)` — programmatic registration
- `runDoctor(opts?)` → `Promise<DoctorReport>`
- `builtInDoctorChecks` — readonly list of the six shipped checks
- Six individual built-in checks: `sandboxPlatformCheck`, `cwdWritableCheck`, `tmpdirWritableCheck`, `vaultRegisteredCheck`, `providersRegisteredCheck`, `telemetryInstalledCheck`

**LLMProvider interface gains optional `doctorCheck?(): Promise<DoctorCheckResult>`.** Non-breaking — existing providers don't need to implement it. Consumers wanting provider health probes register a custom check that walks `ProviderRegistry.getAll()` and calls `provider.doctorCheck?.()` per provider.

**Built-in checks ship intentionally conservative for v1.** `sandbox.platform` passes on darwin if `/usr/bin/sandbox-exec` is executable; inconclusive on linux (proc namespace probe deferred); warn on win32; inconclusive elsewhere. `runtime.cwd-writable` + `runtime.tmpdir-writable` are real `fs.access(W_OK)` probes. `telemetry.installed` dynamic-imports `@namzu/telemetry` (specifier-variable to evade TS resolution since SDK doesn't depend on telemetry); pass if installed, inconclusive if not. `vault.registered` + `providers.registered` are intentionally inconclusive with explicit "register your own check" guidance — vault and provider registries are module-private and aren't auto-discoverable from a standalone process.

**Failure isolation:** a thrown check is recorded as `fail` with the throw message; other checks still run. A check exceeding `perCheckTimeoutMs` (default 5000ms) becomes `inconclusive`. Wall-clock timeout (default 10000ms) marks not-yet-completed checks as `inconclusive`. Status set: `pass | fail | inconclusive | warn`. Only `fail` affects the exit code (1); `inconclusive` and `warn` are informational. Empty registry → exit 2 (no config).

**Embedded usage today, CLI command in the next patch.** Consumers can `import { runDoctor, registerDoctorCheck } from '@namzu/sdk'` and integrate the doctor in their own process where their checks have already executed. The standalone `namzu doctor` CLI command lands in the next patch (Phase 5).
