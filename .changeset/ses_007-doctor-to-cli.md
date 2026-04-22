---
'@namzu/sdk': patch
'@namzu/cli': patch
---

ses_007 Phase 5 — doctor runtime moved from `@namzu/sdk` to `@namzu/cli`. Architectural pivot: kernel = SDK (pure runtime primitives), operator surface = CLI (presentation + tooling).

## Breaking changes — `@namzu/sdk`

The following 12 runtime exports have been **removed** from `@namzu/sdk`. They now live in `@namzu/cli`:

- `doctor` (singleton), `DoctorRegistry`, `createDoctorRegistry`
- `registerDoctorCheck`, `runDoctor`
- `builtInDoctorChecks`
- `sandboxPlatformCheck`, `cwdWritableCheck`, `tmpdirWritableCheck`
- `vaultRegisteredCheck`, `providersRegisteredCheck`, `telemetryInstalledCheck`

The `RunDoctorOptions` type has also been removed from `@namzu/sdk` exports.

**What stays in `@namzu/sdk`:**

- The protocol types — `DoctorCheck`, `DoctorCheckResult`, `DoctorCheckContext`, `DoctorCheckRecord`, `DoctorReport`, `DoctorStatus`, `DoctorCategory` — remain in `types/doctor/` so kernel components can implement custom checks against them.
- `LLMProvider.doctorCheck?(): Promise<DoctorCheckResult>` — the kernel hook that lets a provider expose its own healthcheck stays on the interface.

## Migration

If you were calling the doctor in your own process:

```diff
- import { runDoctor, registerDoctorCheck } from '@namzu/sdk'
+ import { runDoctor, registerDoctorCheck } from '@namzu/cli'
```

If you were running it from the command line:

```bash
# Before — required a custom CLI bin or `pnpm dlx tsx packages/sdk/src/doctor/...`
# After:
pnpm dlx @namzu/cli doctor
# or, after install: namzu doctor
```

Custom check authors continue to import the protocol types from `@namzu/sdk`:

```ts
import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'
import { registerDoctorCheck } from '@namzu/cli'

const myCheck: DoctorCheck = {
	id: 'app.db.reachable',
	category: 'custom',
	run: async (): Promise<DoctorCheckResult> => {
		// your probe
	},
}
registerDoctorCheck(myCheck)
```

## New — `@namzu/cli` (initial public release)

`@namzu/cli` v0.1.0 ships as a public package for the first time. Dual-purpose:

- **Standalone bin** — `npx @namzu/cli doctor`, or after install: `namzu doctor`. Supports `--json`, `--verbose`, `--category <a,b,c>`, `--per-check-timeout <ms>`, `--wall-clock-timeout <ms>`. Sysexits-aligned exit codes (`0` ok, `1` fail, `2` no config, `70` internal error).
- **Library** — `import { runDoctor, registerDoctorCheck, builtInDoctorChecks } from '@namzu/cli'` for embedded usage where consumer code wants to invoke the doctor in its own process so app-registered checks are visible.

**What ships built-in:**

- `sandbox.platform` (darwin sandbox-exec presence + win32 warn + linux/other inconclusive)
- `runtime.cwd-writable` + `runtime.tmpdir-writable` (real `fs.access(W_OK)` probes)
- `telemetry.installed` (dynamic-import probe for `@namzu/telemetry`)
- `vault.registered` + `providers.registered` (intentionally inconclusive — consumers register their own walking their setup)

**Why patch-bump-equivalent:** `@namzu/sdk: minor` carries the breaking removal (pre-1.0 cadence); `@namzu/cli: minor` carries the new package's first feature release. Together they make the next release a coordinated cut.
