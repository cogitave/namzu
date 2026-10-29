import { describe, expect, it } from 'vitest'

import { estimateMessagesTokens } from '../../../../../compaction/token-estimate.js'
import type { Message } from '../../../../../types/message/index.js'
import type { SessionEvent } from '../../../../../types/session/index.js'
import { NOOP_LOGGER } from '../../../../../utils/log/create-logger.js'
import { CompactionBreaker, compactionBreaker } from '../compaction-breaker.js'
import { runCompactionCheck } from '../compaction.js'
import type { IterationContext } from '../context.js'

/**
 * Opt-in circuit breaker: three failed passes in a row switch automatic
 * compaction off; three compactions each followed by a refill within three
 * iterations stop the turn. Each says so once.
 */

const user = (content: string): Message => ({ role: 'user', content, timestamp: 1 })

function context(opts: { breaker: boolean; reducer: () => Message[] | undefined }) {
	const events: SessionEvent[] = []
	const messages: Message[] = Array.from({ length: 40 }, (_, i) => user(`m${i} ${'x'.repeat(400)}`))
	const recorder = { id: 'b55333a6-c5c4-4dc3-b002-b2cfad381d41', messages, currentIteration: 1 }
	let reducerCalls = 0
	const ctx = {
		recorder,
		turnConfig: { model: 'mock-model' },
		compactionConfig: {
			strategy: 'custom',
			triggerThreshold: 0.1,
			contextWindowTokens: 100,
			keepRecentMessages: 2,
			...(opts.breaker ? { circuitBreaker: true } : {}),
		},
		contextReducer: () => {
			reducerCalls++
			return opts.reducer()
		},
		log: NOOP_LOGGER,
		emitEvent: async (event: SessionEvent) => {
			events.push(event)
		},
	} as unknown as IterationContext
	return { ctx, events, recorder, calls: () => reducerCalls }
}

const causes = (events: SessionEvent[]) =>
	events.flatMap((e) => (e.type === 'compaction_failed' ? [e.cause] : []))

describe('compaction gives up after repeated failures', () => {
	it('stops after three failures in a row and says so once', async () => {
		const { ctx, events, calls } = context({ breaker: true, reducer: () => undefined })
		for (let i = 0; i < 6; i++) await runCompactionCheck(ctx)
		expect(calls()).toBe(3)
		expect(causes(events)).toEqual(['shed_nothing', 'shed_nothing', 'shed_nothing', 'breaker_open'])
	})

	it('is silent for the person: the event carries no line to show', async () => {
		const { ctx, events } = context({ breaker: true, reducer: () => undefined })
		for (let i = 0; i < 4; i++) await runCompactionCheck(ctx)
		const open = events.find((e) => e.type === 'compaction_failed' && e.cause === 'breaker_open')
		expect(open).toBeDefined()
		expect(open).not.toHaveProperty('error')
	})

	it('without the opt-in keeps trying on every iteration', async () => {
		const { ctx, calls } = context({ breaker: false, reducer: () => undefined })
		for (let i = 0; i < 6; i++) await runCompactionCheck(ctx)
		expect(calls()).toBe(6)
	})

	it('a forced pass is never gated', async () => {
		const { ctx, calls } = context({ breaker: true, reducer: () => undefined })
		for (let i = 0; i < 4; i++) await runCompactionCheck(ctx)
		await runCompactionCheck(ctx, { force: true })
		expect(calls()).toBe(4)
	})
})

describe('compaction that keeps refilling stops the turn', () => {
	it.each([0, 20])(
		'does not mistake insufficient reductions for refills (tail=%i)',
		async (tail) => {
			const state = { ctx: undefined as unknown as IterationContext }
			const made = context({
				breaker: true,
				reducer: () => state.ctx.recorder.messages.slice(1) as Message[],
			})
			state.ctx = made.ctx
			for (let iteration = 1; iteration <= 6; iteration++) {
				made.recorder.currentIteration = iteration
				const before = estimateMessagesTokens(made.recorder.messages)
				await runCompactionCheck(made.ctx)
				const after = estimateMessagesTokens(made.recorder.messages)
				expect(after).toBeLessThan(before)
				// Every reduction still leaves pressure above the trigger (10 tokens).
				expect(after).toBeGreaterThan(10)
				if (tail > 0) made.recorder.messages.push(user('x'.repeat(tail)))
			}
			expect(made.calls()).toBe(6)
			expect(compactionBreaker(made.ctx)?.stop).toBeUndefined()
			expect(causes(made.events)).toEqual([])
		},
	)

	it('trips on the third quick refill, once', async () => {
		const state = { ctx: undefined as unknown as IterationContext }
		const made = context({
			breaker: true,
			reducer: () => state.ctx.recorder.messages.slice(0, -1) as Message[],
		})
		state.ctx = made.ctx
		for (let iteration = 1; iteration <= 5; iteration++) {
			made.recorder.currentIteration = iteration
			await runCompactionCheck(made.ctx)
			// Replace the space actually shed, not just another quick check.
			made.recorder.messages.push(user('x'.repeat(500)))
		}
		expect(made.calls()).toBe(3)
		expect(compactionBreaker(made.ctx)?.stop).toMatch(/filled up again/)
		// Names the cause and a step that keeps the conversation; never "start over".
		expect(compactionBreaker(made.ctx)?.stop).toMatch(/smaller parts/)
		expect(compactionBreaker(made.ctx)?.stop).not.toMatch(
			/\/clear|\/new|start fresh|new (?:session|conversation)/i,
		)
		expect(causes(made.events)).toEqual(['refilling'])
	})

	it('a slow refill does not count', async () => {
		const state = { ctx: undefined as unknown as IterationContext }
		const made = context({
			breaker: true,
			reducer: () => state.ctx.recorder.messages.slice(0, -1) as Message[],
		})
		state.ctx = made.ctx
		for (const iteration of [1, 5, 9, 13, 17]) {
			made.recorder.currentIteration = iteration
			await runCompactionCheck(made.ctx)
			made.recorder.messages.push(user('x'.repeat(500)))
		}
		expect(made.calls()).toBe(5)
		expect(compactionBreaker(made.ctx)?.stop).toBeUndefined()
	})
})

describe('refill accounting uses the space shed, not just elapsed iterations', () => {
	it('counts three full quick refills and leaves the failure guard independent', () => {
		const breaker = new CompactionBreaker()
		expect(breaker.wouldTrip(1, 1_000)).toBe(false)
		breaker.recordCompaction(1, 1_000, 800)
		for (const iteration of [2, 3]) {
			expect(breaker.wouldTrip(iteration, 1_000)).toBe(false)
			breaker.recordCompaction(iteration, 1_000, 800)
		}
		expect(breaker.wouldTrip(4, 999)).toBe(false)
		expect(breaker.wouldTrip(4, 1_000)).toBe(true)
		for (let i = 0; i < 3; i++) breaker.recordFailure()
		expect(breaker.failuresOpen).toBe(true)
	})

	it('breaks the refill streak when a pass remains under its previous pre-edit size', () => {
		const breaker = new CompactionBreaker()
		for (const iteration of [1, 2, 3]) {
			expect(breaker.wouldTrip(iteration, 1_000)).toBe(false)
			breaker.recordCompaction(iteration, 1_000, 800)
		}
		expect(breaker.wouldTrip(4, 900)).toBe(false)
		breaker.recordCompaction(4, 900, 700)
		expect(breaker.wouldTrip(5, 900)).toBe(false)
		breaker.recordCompaction(5, 900, 700)
		expect(breaker.wouldTrip(6, 900)).toBe(false)
		breaker.recordCompaction(6, 900, 700)
		expect(breaker.wouldTrip(7, 900)).toBe(true)
	})

	it('does not call an unchanged or expanded prompt a refill', () => {
		for (const after of [1_000, 1_100]) {
			const breaker = new CompactionBreaker()
			for (let iteration = 1; iteration <= 6; iteration++) {
				expect(breaker.wouldTrip(iteration, 1_100)).toBe(false)
				breaker.recordCompaction(iteration, 1_000, after)
			}
		}
	})
})
