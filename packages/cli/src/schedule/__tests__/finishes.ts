/**
 * Runs `work` and fails, with the input's name, if it does not finish within a
 * budget that only a super-linear scan can exceed.
 *
 * The "linear time" tests guard against backtracking and quadratic rescans
 * (ReDoS). They used to compare `performance.now()` deltas, which measures how
 * busy the machine is as much as the code: a loaded two-core runner tripped
 * them with nothing broken.
 *
 * A synchronous scan cannot be timed out by Vitest, whose timer never gets to
 * run while the thread is inside it, so a quadratic one would finish minutes
 * later and pass. `vm`'s `timeout` is a watchdog thread that terminates the
 * running JavaScript, regex matching included, so a super-linear scan stops
 * at the budget and fails here instead.
 *
 * The test never reads a clock and never compares two measurements. The inputs
 * are sized so that the linear scans take milliseconds to well under a second
 * and the budget is tens of times that: the verdict is "linear" or "minutes",
 * and a busy machine does not turn one into the other. A regression to
 * quadratic at these sizes runs for minutes (shown in the commit that added
 * this), far past the budget.
 */

import { createContext, runInContext } from 'node:vm'

export function mustFinishWithin<T>(budgetMs: number, what: string, work: () => T): T {
	let result: { value: T } | undefined
	try {
		runInContext(
			'work()',
			createContext({
				work: () => {
					result = { value: work() }
				},
			}),
			{ timeout: budgetMs },
		)
	} catch (error) {
		if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
			throw new Error(
				`${what}: still running after ${budgetMs} ms. Linear work finishes in a small fraction of that; this is a super-linear scan`,
			)
		}
		throw error
	}
	if (result === undefined) throw new Error(`${what}: the work did not complete`)
	return result.value
}
