import { defineConfig } from 'vitest/config'

/**
 * This suite is integration-shaped, and vitest's default 5000ms `testTimeout`
 * is a unit-test default. That mismatch is the whole content of this file.
 *
 * Every other package here carries a `vitest.config.ts`; the CLI, whose tests
 * drive real command handlers and real sessions across the widest module graph
 * in the repository, carried none and inherited the defaults.
 *
 * ## What that cost, measured
 *
 * Four tests boot the CLI + SDK graph with a dynamic `import()` inside the test
 * body, so the module load is billed to the per-test budget. Under the full
 * 44-file parallel run on Windows they land at:
 *
 *   headless-trust-gate      refuses, and does not open a session in it   5217ms
 *   deferred-tool-discovery  the session offers it and a sub-agent does not 5387ms
 *   mcp-servers-reach-…      is in the tool roster the session hands the model 5163ms
 *   permission-rules-reach-… reaches the gate of the turn that enforces it 5139ms
 *
 * All four straddle the 5000ms line. That is why the failure COUNT varied
 * between runs of the same commit — the suite was not flaky in the usual sense,
 * it was four tests sitting within 400ms of a cliff, and how many fell depended
 * on how the workers happened to contend.
 *
 * The follow-on damage made it read as two more unrelated defects. A test vitest
 * abandons at the timeout keeps running: its handles were still open on the temp
 * directory when `afterEach` removed it, which surfaced as `EBUSY: resource busy
 * or locked, rmdir`, and the aborted test's successor then asserted against state
 * its predecessor never finished writing (`expected undefined to deeply equal`).
 * Both vanish when nothing is abandoned; neither was a Windows filesystem bug.
 *
 * ## Why widening the budget is the fix rather than a cover-up
 *
 * The 5 seconds are spent in vite transforming TypeScript source. A shipped CLI
 * runs compiled `dist/`, so production never pays this cost and there is no
 * product defect behind these numbers. Nothing under `src/` needed to change.
 *
 * 15s is ~3x the measured worst case: enough headroom for a more loaded machine,
 * and still short enough to fail a genuine hang rather than let CI sit on it. It
 * stays below the deliberate 20s/40s budgets in `integrations/mcp/connect.test.ts`,
 * so those keep reading as "longer on purpose" rather than merging into the floor.
 *
 * CI runs ubuntu-latest only, where the transform is fast enough that all four
 * pass. This was therefore invisible to the gate and visible only to a
 * contributor on Windows.
 */
export default defineConfig({
	test: {
		testTimeout: 15_000,
		// LOG-05: every entry point now installs a REAL stderr sink instead of
		// forcing the level to `silent` via `configureLogger`, so a `ctx` a
		// test built by hand without a `logging` field falls back to
		// resolving the level from NAMZU_LOG_LEVEL — see `contextLogging` in
		// `src/logging.ts`. Defaulting that env var to `silent` here
		// (`src/test-setup.ts`) keeps the dozen-plus existing fixtures across
		// this package quiet without editing any of them.
		setupFiles: ['./src/test-setup.ts'],
	},
})
