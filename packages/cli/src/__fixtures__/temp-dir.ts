/**
 * Remove a temp directory a test made, without letting the removal fail the
 * test.
 *
 * ## The finding this exists for
 *
 * A full-suite run went red on `archived-workspace.test.ts`:
 *
 *     × names the workspace in the refusal 11ms
 *       → ENOTEMPTY: directory not empty, rmdir '…/.namzu/projects/prj_…'
 *
 * The assertion passed. The error came from `afterEach`, and vitest attributes
 * a hook failure to the test it ran after — so a temp-directory deletion race
 * was reported as a product test failure, on a test whose claim was never in
 * doubt.
 *
 * That is the defect, and it is not confined to one file: thirty call sites in
 * this package delete a temp tree in a hook, and any of them can turn a passing
 * assertion into a red run for a reason that has nothing to do with the code
 * under test. A suite that goes red for unexplained reasons teaches people to
 * re-run rather than read, which costs more than the flake.
 *
 * ## Retry first, because the platform documents this exact case
 *
 * `fs.rmSync` takes `maxRetries` precisely for `EBUSY`, `EMFILE`, `ENFILE`,
 * `ENOTEMPTY` and `EPERM`, and defaults it to **0** — so every one of those
 * sites had no retry at all on the platform where transient locking is
 * ordinary. Using the remedy the API provides is not a guess about the cause.
 *
 * ## Warn rather than throw, because nothing here was ever a check
 *
 * If the retries are exhausted this warns and returns. That is not a check
 * being degraded: no test asserts that cleanup succeeded, so there was no check
 * to lose. What is removed is a channel that can only ever produce a FALSE red,
 * and the warning keeps the information — a genuine handle leak still shows up,
 * named, on every affected run, instead of surfacing as an unrelated test
 * failing one time in ten.
 *
 * A leftover directory under the OS temp root is not a defect worth failing a
 * passing test over; the OS reclaims it.
 *
 * ## What is NOT claimed
 *
 * The original `ENOTEMPTY` was observed once and could not be reproduced — not
 * in 15 isolated runs, not in 6 full-suite runs, not in an 80-round synthetic
 * stress with concurrent filesystem load. So this does not assert a root cause.
 * It removes the ability of cleanup to report a failure the code did not have,
 * which is correct whatever the cause turns out to be.
 */

import { rmSync } from 'node:fs'

export function removeTempDir(path: string): void {
	try {
		// Linear backoff: ~50ms, 100ms, … up to ten attempts. Generous, because
		// this runs once per test and a slow delete costs less than a false red.
		rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err)
		// biome-ignore lint/suspicious/noConsole: the warning IS the feature. This
		// runs only in tests, and the whole point of not throwing is that the
		// information survives somewhere a reader will see it. Routing it through
		// a logger nobody configures in a test process would lose it.
		console.warn(
			`[test cleanup] could not remove ${path} after 10 attempts: ${reason}\n  The test result above is unaffected. If this recurs, something is holding a handle.`,
		)
	}
}
