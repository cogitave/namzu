/**
 * Remove a temp directory a test made, without letting the removal fail the
 * test.
 *
 * ## The finding this exists for
 *
 * A full-suite run in `packages/cli` went red on a test whose assertion had
 * passed:
 *
 *     × names the workspace in the refusal 11ms
 *       → ENOTEMPTY: directory not empty, rmdir '…/.namzu/projects/prj_…'
 *
 * The error came from `afterEach`, and vitest attributes a hook failure to the
 * test it ran after — so a temp-directory deletion race was reported as a
 * product test failure, on a test whose claim was never in doubt. A suite that
 * goes red for unexplained reasons teaches people to re-run rather than read,
 * which costs more than the flake.
 *
 * That defect was never one package's. `packages/cli` fixed thirty call sites;
 * this package had fifty-nine, every one of them inside an `afterEach`.
 *
 * ## Retry first, because the platform documents this exact case
 *
 * `fs.rmSync` and `fsPromises.rm` both take `maxRetries` precisely for `EBUSY`,
 * `EMFILE`, `ENFILE`, `ENOTEMPTY` and `EPERM`, and both default it to **0** —
 * so every bare site had no retry at all for the errors the API exists to
 * absorb. Using the remedy the API provides is not a guess about the cause.
 *
 * ## Warn rather than throw, because nothing here was ever a check
 *
 * If the retries are exhausted these warn and return. That is not a check being
 * degraded: no test asserts that cleanup succeeded, so there is no check to
 * lose. What is removed is a channel that can only ever produce a FALSE red,
 * and the warning keeps the information — a genuine handle leak still shows up,
 * named, on every affected run, instead of surfacing as an unrelated test
 * failing one time in ten.
 *
 * The same argument is why this is for TEARDOWN only. A delete a caller asked
 * for is a check, and the four `rm` calls in this package's product code stay
 * exactly as they are: `deleteSession` reporting success it did not achieve is
 * the failure this file would cause if it were pointed at them.
 *
 * A leftover directory under the OS temp root is not a defect worth failing a
 * passing test over; the OS reclaims it.
 *
 * ## What is NOT claimed
 *
 * The original `ENOTEMPTY` was observed once and could not be reproduced — not
 * in 15 isolated runs, not in 6 full-suite runs, not in an 80-round synthetic
 * stress with concurrent filesystem load. So this asserts no root cause. It
 * removes the ability of cleanup to report a failure the code did not have,
 * which is correct whatever the cause turns out to be.
 */

import { rmSync } from 'node:fs'
import { rm } from 'node:fs/promises'

/**
 * Linear backoff: ~50ms, 100ms, … up to ten attempts. Generous, because this
 * runs once per test and a slow delete costs less than a false red.
 */
const RETRY = { maxRetries: 10, retryDelay: 50 } as const

function warn(path: string, err: unknown): void {
	const reason = err instanceof Error ? err.message : String(err)
	// The warning IS the feature. This runs only in tests, and the whole point
	// of not throwing is that the information survives somewhere a reader will
	// see it. Routing it through a logger would lose it outright: this package's
	// own `test-setup.ts` configures the root logger to `silent` for every test
	// run, on purpose.
	//
	// The suppression is the LAST line of this comment deliberately. A
	// `biome-ignore` line suppresses the line that follows it, so with the prose
	// underneath it the suppression lands on a comment and biome reports both
	// `noConsole` and `suppressions/unused` — which is the state
	// `packages/cli/src/__fixtures__/temp-dir.ts` is still in.
	// biome-ignore lint/suspicious/noConsole: a test-only warning that must reach a human
	console.warn(
		`[test cleanup] could not remove ${path} after ${RETRY.maxRetries} attempts: ${reason}\n  The test result above is unaffected. If this recurs, something is holding a handle.`,
	)
}

/** Remove one temp tree synchronously. */
export function removeTempDir(path: string): void {
	try {
		rmSync(path, { recursive: true, force: true, ...RETRY })
	} catch (err) {
		warn(path, err)
	}
}

/** Remove one temp tree without blocking the event loop. */
export async function removeTempDirAsync(path: string): Promise<void> {
	try {
		await rm(path, { recursive: true, force: true, ...RETRY })
	} catch (err) {
		warn(path, err)
	}
}

/**
 * Remove several temp trees concurrently.
 *
 * Takes an array rather than `string | string[]`: a union would accept a bare
 * path, and a string is iterable by character, so one wrong call site would
 * silently try to delete `/`, `t`, `m`, `p`. The type refuses it instead.
 */
export async function removeTempDirs(paths: readonly string[]): Promise<void> {
	await Promise.all(paths.map((path) => removeTempDirAsync(path)))
}
