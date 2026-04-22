# @namzu/cli

## 0.0.1

### Patch Changes

- 8f076e5: ses_007 Phase 5 — doctor runtime moved from `@namzu/sdk` to `@namzu/cli`. Architectural pivot: kernel = SDK (pure runtime primitives), operator surface = CLI (presentation + tooling).

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
  import type { DoctorCheck, DoctorCheckResult } from "@namzu/sdk";
  import { registerDoctorCheck } from "@namzu/cli";

  const myCheck: DoctorCheck = {
    id: "app.db.reachable",
    category: "custom",
    run: async (): Promise<DoctorCheckResult> => {
      // your probe
    },
  };
  registerDoctorCheck(myCheck);
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

- 82220e3: Doctor — `runDoctor()` accepts streaming callbacks + cooperative cancellation (ses_013 Phase 1).

  Three new optional fields on `RunDoctorOptions`:

  - **`onCheckStart(check)`** — fires immediately before each check's `run()` is invoked.
  - **`onCheckComplete(record)`** — fires exactly once per check after its record is built (whether `pass`, `fail`, `inconclusive`, or `warn`). Defended against double-fire by the same `completed` map that pins the record.
  - **`signal?: AbortSignal`** — cooperative cancellation. When the signal aborts, in-flight checks stop being awaited; their records become `inconclusive` with an "aborted by signal" message. Completed records are preserved verbatim.

  Throwing callbacks are caught + logged + never affect the doctor run or the final `DoctorReport`.

  Substrate for the upcoming TUI mode (later patch in this same series), useful standalone for analytics or custom progress UIs.

  Internal: `packages/cli/tsconfig.json` adds `"jsx": "react-jsx"` + `"jsxImportSource": "react"` in preparation for the TUI's `.tsx` files. No `.tsx` files yet; typecheck still passes. Purely additive — no consumer behavior change.

- 0ba357d: Doctor registry — preserve completed records on wall-timeout + double-fire defense (ses_013 Phase 0).

  Two pre-existing bugs in `DoctorRegistry.run()` surfaced by the ses_013 codex adversarial review:

  - **Wall-timeout aggregation no longer erases completed records.** Before: when the wall-clock timer won the race, every check was mapped to `inconclusive`, even ones that already finished. Fast pass + slow timeout produced 0 pass + N inconclusive. After: only checks that haven't finished by the wall-clock deadline are marked `inconclusive`; completed records are preserved verbatim. Fast pass + slow timeout now correctly produces 1 pass + (N-1) inconclusive.
  - **Completion can no longer double-fire.** A check whose per-check timeout fired microseconds before/after the check itself resolved could produce duplicate records. Defended by an `if (completed.has(check.id)) return` guard inside the per-check callback. First record wins.

  No public API change — bug fix only. 4 new tests pin the corrected contract; suite total 22 → 26.

- Updated dependencies [aead3a8]
- Updated dependencies [8f076e5]
  - @namzu/sdk@0.4.5
