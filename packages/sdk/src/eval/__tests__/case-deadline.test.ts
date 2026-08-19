import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'

import { runExperiment } from '../experiment.js'
import type { EvalRun } from '../types.js'

/**
 * `executeCase` was a bare await, so a `run` closure that never settled
 * blocked its worker and `runExperiment` never returned — no report, no
 * partial results, nothing to read.
 *
 * Narrower than it sounds: the documented path inherits three deadlines
 * from the runtime it drives. The residual is a closure that does not go
 * through `query()`, and a mid-iteration provider stall the
 * between-iterations guard cannot see. Both are reachable, and neither is
 * the suite's to absorb silently.
 */

const emptyRun = (): EvalRun => ({
	output: 'ok',
	steps: [],
	toolCalls: [],
	totalTokens: 0,
	totalCostUsd: 0,
	durationMs: 0,
})

const never = () => new Promise<EvalRun>(() => {})

const scorer = {
	name: 'always-one',
	score: async () => ({ score: 1, reason: 'fine' }),
}

describe('a case that never settles', () => {
	it('is reported instead of hanging the suite', async () => {
		const report = await runExperiment({
			name: 'deadline',
			cases: [{ name: 'hangs', input: null }],
			scorers: [scorer],
			timeoutMs: 20,
			run: never,
		})

		expect(report.cases).toHaveLength(1)
		expect(report.cases[0]?.run.error).toMatch(/timed out after 20ms/)
	})

	it('does not take the rest of the suite with it', async () => {
		// Forty cases should not be lost to one that hung — the same rule
		// the harness already applied to a case that threw.
		const report = await runExperiment({
			name: 'deadline',
			cases: [
				{ name: 'hangs', input: null },
				{ name: 'fine', input: null },
			],
			scorers: [scorer],
			timeoutMs: 20,
			run: async (_input, evalCase) => (evalCase.name === 'hangs' ? await never() : emptyRun()),
		})

		expect(report.cases.map((c) => c.case).sort()).toEqual(['fine', 'hangs'])
		expect(report.passed).toBe(1)
		expect(report.failed).toBe(1)
	})

	it('reports the time it actually burned, not zero', async () => {
		// A case that spent its whole deadline is the most interesting
		// number in the report; zero would hide it.
		const report = await runExperiment({
			name: 'deadline',
			cases: [{ name: 'hangs', input: null }],
			scorers: [scorer],
			timeoutMs: 30,
			run: never,
		})

		expect(report.cases[0]?.run.durationMs).toBeGreaterThanOrEqual(20)
	})
})

describe('the signal handed to run', () => {
	it('fires when the deadline passes, so a cooperating closure can stop', async () => {
		let aborted = false
		await runExperiment({
			name: 'deadline',
			cases: [{ name: 'watches', input: null }],
			scorers: [scorer],
			timeoutMs: 20,
			run: async (_input, _case, signal) => {
				signal.addEventListener('abort', () => {
					aborted = true
				})
				return await never()
			},
		})

		expect(aborted).toBe(true)
	})

	it('stays quiet for a case that finished in time', async () => {
		// A spurious abort after the work is done would train a closure to
		// ignore the signal entirely.
		let aborted = false
		let retainedSignal: AbortSignal | undefined
		await runExperiment({
			name: 'deadline',
			cases: [{ name: 'fast', input: null }],
			scorers: [scorer],
			timeoutMs: 5_000,
			run: async (_input, _case, signal) => {
				retainedSignal = signal
				signal.addEventListener('abort', () => {
					aborted = true
				})
				return emptyRun()
			},
		})

		expect(aborted).toBe(false)
		// The host is allowed to retain the public signal after returning.
		// The harness must not leave its private expiry promise attached to it.
		expect(getEventListeners(retainedSignal as AbortSignal, 'abort')).toHaveLength(1)
	})
})

describe('a suite with no deadline set', () => {
	it('behaves exactly as before', async () => {
		const report = await runExperiment({
			name: 'no-deadline',
			cases: [{ name: 'fine', input: null }],
			scorers: [scorer],
			run: async () => emptyRun(),
		})

		expect(report.passed).toBe(1)
		expect(report.cases[0]?.run.error).toBeUndefined()
	})

	it('still turns a throw into a result rather than a crash', async () => {
		const report = await runExperiment({
			name: 'no-deadline',
			cases: [{ name: 'throws', input: null }],
			scorers: [scorer],
			run: async () => {
				throw new Error('broken case')
			},
		})

		expect(report.cases[0]?.run.error).toBe('broken case')
	})
})

describe('the case deadline is a real platform timer', () => {
	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2_147_483_648])(
		'refuses %s before invoking a case',
		async (timeoutMs) => {
			let calls = 0
			await expect(
				runExperiment({
					name: 'invalid deadline',
					cases: [{ name: 'must not start', input: null }],
					scorers: [scorer],
					timeoutMs,
					run: async () => {
						calls++
						return emptyRun()
					},
				}),
			).rejects.toThrow(/timeoutMs must be an integer from 1 to 2147483647, or omitted/)
			expect(calls).toBe(0)
		},
	)
})
