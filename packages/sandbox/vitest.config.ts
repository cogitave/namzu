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
		exclude: ['**/node_modules/**', '**/dist/**', '**/*.smoke.test.ts'],
	},
})
