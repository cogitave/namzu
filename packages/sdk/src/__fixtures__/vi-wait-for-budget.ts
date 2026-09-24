/**
 * Vitest `setupFiles` entry: gives `vi.waitFor` a budget tied to this
 * package's real per-test timeout instead of its own unrelated 1000ms
 * default (interval 50ms).
 *
 * `vi.waitFor(callback)` with no explicit timeout races that fixed 1s wall
 * clock against whatever real async work the callback is polling for. On a
 * loaded CI runner that work can legitimately take longer than 1s with
 * nothing broken, and `vi.waitFor` gives up first — the same real-time-race
 * class as every `Promise.race`/`setTimeout` hang-guard fixed elsewhere on
 * this branch, just at a call site that sweep (which searched for explicit
 * numeric timeouts) could not see. Reported in `@namzu/cli`'s
 * `run-limits-config.test.tsx`; this package's own suite has 32 bare
 * `vi.waitFor(callback)` call sites with the identical exposure.
 *
 * There is no documented vitest config for `vi.waitFor`'s own default the
 * way `test.expect.poll.timeout` configures `expect.poll()` (checked:
 * vitest 4.1's `TestOptions.expect.poll` covers only `expect.poll`,
 * `vi.waitFor` reads no config at all) — so this wraps it directly. A caller
 * that already passes a timeout (a number, or an options object naming one)
 * keeps exactly what it asked for; only an omitted timeout is affected.
 *
 * The budget is the REMAINING time in the current test, not a flat
 * per-call constant: a case can chain several bare `vi.waitFor`s, and
 * hard-coding each one's ceiling near the full per-test timeout would let
 * their worst cases sum to several times over it — moving the failure from
 * a specific, descriptive `vi.waitFor` message to a generic "Test timed
 * out" once the LAST wait in the chain exhausts a budget none of the
 * earlier ones actually had to give back. Tracking the test's own start
 * lets each wait's ceiling shrink as the test spends its real budget, so a
 * chain still fails inside `testTimeout`, at whichever wait actually ran
 * out of it. See `packages/cli/src/test-setup.ts` for the sibling fix and
 * the measurement behind this design (a flat ~13s-per-call ceiling still
 * failed a multi-wait CLI case under a starved core; the remaining-budget
 * version passed).
 */
import { beforeEach, vi } from 'vitest'

// No `testTimeout` override in this package's `vitest.config.ts` or
// `vitest.proc.config.ts`, so both suites run on vitest's own 5000ms
// default. Update this constant if either config ever sets one.
const SDK_TEST_TIMEOUT_MS = 5_000
const WAIT_FOR_TIMEOUT_MARGIN_MS = 1_000
const MIN_WAIT_FOR_TIMEOUT_MS = 300

let currentTestStartedAt: number | undefined
beforeEach(() => {
	currentTestStartedAt = performance.now()
})

function defaultWaitForTimeoutMs(): number {
	const elapsed = currentTestStartedAt === undefined ? 0 : performance.now() - currentTestStartedAt
	return Math.max(
		MIN_WAIT_FOR_TIMEOUT_MS,
		SDK_TEST_TIMEOUT_MS - elapsed - WAIT_FOR_TIMEOUT_MARGIN_MS,
	)
}

// Idempotent under a marker rather than a plain module-local flag: this file
// is a `setupFiles` entry and reruns fresh before every test file, but `vi`
// is the one live singleton those reruns share, so re-wrapping an
// already-wrapped `waitFor` on the second file would silently nest a second
// layer around the first.
const ORIGINAL_WAIT_FOR = Symbol.for('namzu.sdk.vi-wait-for-budget.vi.waitFor.original')
type ViWithOriginalWaitFor = typeof vi & { [ORIGINAL_WAIT_FOR]?: typeof vi.waitFor }
const viInternal = vi as ViWithOriginalWaitFor
const realWaitFor = viInternal[ORIGINAL_WAIT_FOR] ?? vi.waitFor
viInternal[ORIGINAL_WAIT_FOR] = realWaitFor
vi.waitFor = ((callback, options) => {
	if (options === undefined) return realWaitFor(callback, defaultWaitForTimeoutMs())
	if (typeof options === 'number') return realWaitFor(callback, options)
	return realWaitFor(callback, { timeout: defaultWaitForTimeoutMs(), ...options })
}) as typeof vi.waitFor
