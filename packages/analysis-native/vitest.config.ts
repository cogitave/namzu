import { defineConfig } from 'vitest/config'

/**
 * `dist` mirrors `src` (this package compiles its tests), and Vitest 4 no
 * longer excludes it by default, so without this list every test would run
 * twice. The `node_modules` pattern is restated because `exclude` replaces the
 * default list.
 *
 * The timeout is raised from 5 s because the suite spawns the real sidecar
 * and, on a loaded runner, process start-up plus a 290 MB extraction can take
 * longer than that without anything being wrong. No test decides its outcome
 * by racing a timer: a genuine hang is caught by this limit alone.
 */
export default defineConfig({
	test: {
		exclude: ['**/node_modules/**', '**/dist/**'],
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
})
