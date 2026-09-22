import { describe, expect, it, vi } from 'vitest'

import type { TurnRecorder } from '../../../manager/session/turn-recorder.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import type { SessionId } from '../../../types/ids/index.js'
import { GuardCoordinator } from '../guard.js'

/**
 * Budgets belong to the TURN, not to the process hosting it.
 *
 * A turn checkpointed at $4.80 of a $5 cap used to come back with a brand-new
 * $5 and a brand-new timeout clock, because the resume path replayed messages
 * and nothing else — while the checkpoint had faithfully persisted usage,
 * cost and elapsed time all along. A task that parked five times spent 5x its
 * cap with every invocation truthfully reporting itself in budget.
 */

function runMgrAt(opts: {
	totalTokens?: number
	totalCost?: number
	iteration?: number
}): TurnRecorder {
	return {
		tokenUsage: { totalTokens: opts.totalTokens ?? 0 },
		costInfo: { totalCost: opts.totalCost ?? 0 },
		currentIteration: opts.iteration ?? 0,
	} as unknown as TurnRecorder
}

const live = new AbortController().signal

describe('GuardCoordinator — elapsed time survives a resume', () => {
	it('a fresh guard has spent none of its timeout', () => {
		const guard = new GuardCoordinator({ tokenBudget: 0, timeoutMs: 10_000 })
		expect(guard.beforeIteration(runMgrAt({}), live).shouldStop).toBe(false)
	})

	it('stops immediately when the restored elapsed time already exceeds the timeout', () => {
		const guard = new GuardCoordinator({ tokenBudget: 0, timeoutMs: 10_000 })
		guard.restoreElapsed(11_000)

		const result = guard.beforeIteration(runMgrAt({}), live)
		expect(result.shouldStop).toBe(true)
		expect(result.stopReason).toBe('timeout')
	})

	it('force-finalizes when the restored elapsed time is past the warning threshold', () => {
		const guard = new GuardCoordinator({ tokenBudget: 0, timeoutMs: 10_000 })
		guard.restoreElapsed(9_500) // 95% of budget, warn at 90%

		const result = guard.beforeIteration(runMgrAt({}), live)
		expect(result.shouldStop).toBe(false)
		expect(result.forceFinalize).toBe(true)
	})

	it('accepts the offset at construction too', () => {
		const guard = new GuardCoordinator({
			tokenBudget: 0,
			timeoutMs: 10_000,
			elapsedMsOffset: 11_000,
		})
		expect(guard.beforeIteration(runMgrAt({}), live).stopReason).toBe('timeout')
	})

	it('treats a negative offset as zero rather than buying extra time', () => {
		const guard = new GuardCoordinator({
			tokenBudget: 0,
			timeoutMs: 10_000,
			elapsedMsOffset: -60_000,
		})
		expect(guard.beforeIteration(runMgrAt({}), live).shouldStop).toBe(false)
	})

	it('a resumed turn already over its cost cap stops on its first iteration', () => {
		const guard = new GuardCoordinator({ tokenBudget: 0, timeoutMs: 600_000, costLimitUsd: 5 })
		// Post-restore state: the turn had already spent $4.90 before the park.
		const result = guard.beforeIteration(runMgrAt({ totalCost: 5.1 }), live)
		expect(result.shouldStop).toBe(true)
		expect(result.stopReason).toBe('cost_limit')
	})

	it('a resumed turn already at its iteration cap stops on its first iteration', () => {
		const guard = new GuardCoordinator({
			tokenBudget: 0,
			timeoutMs: 600_000,
			maxIterations: 20,
		})
		expect(guard.beforeIteration(runMgrAt({ iteration: 20 }), live).stopReason).toBe(
			'max_iterations',
		)
	})
})

describe('TurnRecorder.restoreUsage', () => {
	it('replaces the counters rather than adding to them', async () => {
		const { TurnRecorder } = await import('../../../manager/session/turn-recorder.js')
		const mgr = new TurnRecorder({
			turnId: 'f4e0af37-43f7-48fd-82b0-f1b1c68881d3',
			agentId: 'a',
			agentName: 'A',
			turnConfig: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
			providerId: 'mock',
			log: {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				child: vi.fn(() => ({
					info: vi.fn(),
					warn: vi.fn(),
					error: vi.fn(),
					debug: vi.fn(),
					child: vi.fn(),
				})),
			},
			sessionId: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
			topicId: 't',
			projectId: 'p',
			tenantId: 'tn',
			sessionLog: new InMemorySessionLog({
				sessionId: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f' as SessionId,
			}),
		} as any)

		// `mock` is in no rate card, which is the point here: this case is about
		// token totals surviving a restore, and an unpriced subject keeps the
		// cost arithmetic out of an assertion that is not about it.
		const servedBy = { providerId: 'mock', model: 'mock-model' }

		mgr.accumulateUsage(
			{
				promptTokens: 10,
				completionTokens: 5,
				totalTokens: 15,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			servedBy,
		)
		expect(mgr.tokenUsage.totalTokens).toBe(15)

		mgr.restoreUsage(
			{
				promptTokens: 900,
				completionTokens: 100,
				totalTokens: 1000,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			{
				inputCostPer1M: 0,
				outputCostPer1M: 0,
				totalCost: 4.8,
				cacheDiscount: 0,
				unpricedTokens: 0,
			},
			7,
		)

		// Restore, not accumulate: the checkpoint holds absolute totals.
		expect(mgr.tokenUsage.totalTokens).toBe(1000)
		expect(mgr.costInfo.totalCost).toBe(4.8)
		expect(mgr.currentIteration).toBe(7)

		// And the turn keeps accumulating from the restored point.
		mgr.accumulateUsage(
			{
				promptTokens: 1,
				completionTokens: 1,
				totalTokens: 2,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			servedBy,
		)
		expect(mgr.tokenUsage.totalTokens).toBe(1002)
		expect(mgr.incrementIteration()).toBe(8)
	})
})
