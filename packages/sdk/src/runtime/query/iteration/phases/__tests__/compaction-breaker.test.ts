import { describe, expect, it } from 'vitest'

import type { Message } from '../../../../../types/message/index.js'
import type { SessionEvent } from '../../../../../types/session/index.js'
import { NOOP_LOGGER } from '../../../../../utils/log/create-logger.js'
import { compactionBreaker } from '../compaction-breaker.js'
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
		}
		expect(made.calls()).toBe(3)
		expect(compactionBreaker(made.ctx)?.stop).toMatch(/filled up again/)
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
		}
		expect(made.calls()).toBe(5)
		expect(compactionBreaker(made.ctx)?.stop).toBeUndefined()
	})
})
