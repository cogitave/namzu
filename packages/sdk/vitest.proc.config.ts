import { defineConfig } from 'vitest/config'

/**
 * Tests that spawn a child process, run on their own.
 *
 * Some behaviour cannot be observed from inside a test runner. The one this
 * exists for is whether a run keeps its own process alive: a runner holds the
 * event loop open for the whole file, so a run that would die on its own
 * footprint finishes happily under `vitest` and the bug ships. Proving it
 * needs a real `node` process with nothing else in it.
 *
 * They are separated rather than merged into the unit suite because the spawn
 * competes for CPU hard enough to flake the timing-sensitive tests running
 * beside it — measured: three different tests failed across two runs of the
 * full suite with this file in, and none with it out. Separated, not skipped:
 * `pnpm --filter @namzu/sdk test:proc` runs them and CI runs that step.
 */
export default defineConfig({
	test: {
		include: ['src/**/*.proc-test.ts'],
		// No `setupFiles` — same reason as `vitest.config.ts`'s. The file it
		// named existed to silence a process-wide stderr logger that LOG-20
		// removed, and it installed a process sink to do it, which collided
		// with every suite that installs its own.
		// One at a time. These measure what a process does when nothing else is
		// in it; running two at once would put something else in it.
		fileParallelism: false,
	},
})
