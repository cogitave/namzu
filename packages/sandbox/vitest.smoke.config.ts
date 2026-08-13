import { defineConfig } from 'vitest/config'

/**
 * The docker-touching smoke suite, which the default config excludes.
 *
 * It needs its own config because `vitest.config.ts` excludes
 * `**\/*.smoke.test.ts` from every run it governs — including the one
 * `test:smoke` was meant to be. Naming the files as CLI arguments does not
 * override that: positional arguments are a filter applied to the files
 * discovery already found. So `pnpm sandbox:smoke` reported
 * "No test files found, exiting with code 0" and the workflow went green,
 * after building a Debian image with a browser and an office suite in it to
 * run nothing at all.
 *
 * `--passWithNoTests` is deliberately NOT set here. An empty smoke run is
 * the failure this file exists to make loud: the suite's own fail-fast
 * guard (`process.env.CI === 'true'` with docker or the image missing) can
 * only fire once a file is loaded, so a discovery bug disables the guard
 * that was supposed to catch a misconfiguration.
 */
export default defineConfig({
	test: {
		include: ['src/**/*.smoke.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**'],
		// A container spawn, a worker handshake and a teardown do not fit in
		// vitest's 5s default, and a timeout here reads as a product failure.
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
})
