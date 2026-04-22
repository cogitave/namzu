# @namzu/cli

Operator CLI for the [Namzu](https://namzu.ai) agent platform.

Dual-purpose:
- **Standalone bin** — `npx @namzu/cli doctor` (or after install: `namzu doctor`).
- **Library** — `import { runDoctor, registerDoctorCheck } from '@namzu/cli'` for embedded usage where consumer code wants to invoke the doctor in its own process so app-registered checks are visible.

## Install

```bash
pnpm add -D @namzu/cli
# or, for one-off invocations:
pnpm dlx @namzu/cli doctor
```

## Commands

### `namzu doctor`

Run health checks against the local Namzu environment.

```
namzu doctor                              # human-readable, all categories
namzu doctor --json                       # machine-readable JSON
namzu doctor --category sandbox,runtime   # filter by category
namzu doctor --per-check-timeout 8000     # raise per-check timeout
namzu doctor --verbose                    # include failure detail
```

**Exit codes** (sysexits-aligned):

| Code | Name                  | Meaning                                     |
| ---: | --------------------- | ------------------------------------------- |
|  `0` | `EXIT_OK`             | All checks passed (or no failure produced). |
|  `1` | `EXIT_FAIL`           | One or more checks reported `fail`.         |
|  `2` | `EXIT_NO_CONFIG`      | No checks registered (Namzu not set up).    |
| `70` | `EXIT_INTERNAL_ERROR` | sysexits `EX_SOFTWARE`; CLI bug.            |

**Built-in checks** ship intentionally conservative; consumers register their own via `registerDoctorCheck()`:

- `sandbox.platform` — darwin sandbox-exec presence; warn on win32; inconclusive on linux.
- `runtime.cwd-writable`, `runtime.tmpdir-writable` — `fs.access(W_OK)` probes.
- `telemetry.installed` — pass if `@namzu/telemetry` is dynamically importable.
- `vault.registered`, `providers.registered` — inconclusive with "register your own" guidance.

## Library API

```ts
import { runDoctor, registerDoctorCheck, builtInDoctorChecks } from '@namzu/cli'
import { ProviderRegistry } from '@namzu/sdk'

// Register a custom check that walks YOUR provider registry
registerDoctorCheck({
	id: 'app.providers.reachable',
	category: 'providers',
	run: async () => {
		const providers = ProviderRegistry.getAll()
		const results = await Promise.all(
			providers.map((p) => p.doctorCheck?.() ?? { status: 'inconclusive' as const }),
		)
		const failed = results.filter((r) => r.status === 'fail')
		return failed.length > 0
			? { status: 'fail', message: `${failed.length} provider(s) failed reachability` }
			: { status: 'pass', message: `${providers.length} provider(s) reachable` }
	},
})

const report = await runDoctor()
process.exit(report.exit)
```

## Architecture

The doctor's protocol types (`DoctorCheck`, `DoctorCheckResult`, `DoctorReport`, `DoctorStatus`) live in `@namzu/sdk` so kernel components (providers, vaults, sandboxes) can implement `doctorCheck?()` hooks against them. The runtime (registry, runner, output formatting, exit codes) lives here in `@namzu/cli` because it's operator-facing concerns. This is the [`ses_007-probe-and-doctor`](https://github.com/cogitave/namzu/tree/main/docs.local/sessions/ses_007-probe-and-doctor) split.

## License

MIT
