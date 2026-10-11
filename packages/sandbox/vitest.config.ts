import { availableParallelism } from 'node:os'
import { defineConfig } from 'vitest/config'

/**
 * Test discovery split between unit tests and docker-touching smoke
 * tests. Default `pnpm test` runs only `*.test.ts` (pure unit, no
 * docker daemon required, safe in CI). The smoke tests under
 * `*.smoke.test.ts` exercise the full `docker run` → worker handshake
 * → container teardown flow and are opt-in via:
 *
 *   pnpm --filter @namzu/sandbox test:smoke
 *   # or, from the monorepo root:
 *   pnpm sandbox:smoke
 *
 * Smoke tests run on a dedicated CI workflow
 * (`.github/workflows/sandbox-smoke.yml`) that builds the reference
 * image and exercises the leaf-permission contract; on a developer
 * machine with docker installed they can be run locally with the
 * same command. When `process.env.CI === 'true'` and docker / the
 * image are absent, the smoke tests fail fast (rather than silently
 * skip) so a CI misconfiguration cannot mask a regression.
 *
 * The `exclude` below governs every run this config is used for, so
 * `test:smoke` cannot re-include the files by naming them — positional
 * arguments filter what discovery already found. It has its own config
 * (`vitest.smoke.config.ts`) for exactly that reason; changing the pattern
 * here means changing the `include` there too, or the suite silently stops
 * being discovered by either.
 */
export default defineConfig({
	test: {
		// Keeps the kernel's default state root out of the user's home.
		globalSetup: ['../../tools/vitest-state-root.mjs'],
		// The fake API and short-deadline suites use real event-loop timers.
		// Dozens of workers on a many-core host can starve them long enough to
		// fail valid lifecycle assertions. Keep useful parallelism without that
		// unrelated scheduling pressure.
		maxWorkers: Math.min(4, availableParallelism()),
		// Vitest's 5 s default is not a budget these suites can promise. Almost
		// every case drives a real agent process, PTY or socket, and a case that
		// takes 40 ms alone (the firecracker conformance file IO round-trips,
		// measured) timed out at 5 s in one of five whole-package runs with
		// four CPU-bound processes sharing the same two cores
		// (`taskset -c 0,1`), where the package took ~490 s against ~150 s
		// unloaded; the conformance mutation cases, ~3.5 s alone, measured
		// 3.9-5.7 s in the same conditions. A genuine hang still fails, at 30 s.
		testTimeout: 30_000,
		exclude: ['**/node_modules/**', '**/dist/**', '**/*.smoke.test.ts'],
	},
})
