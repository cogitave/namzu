import type { SessionEvent } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { USAGE_NOTIFICATION, createUsageFeed } from '../desktop-usage-feed.js'

function harness() {
	let clock = 1_000
	const sent: Record<string, unknown>[] = []
	const timers: { at: number; run: () => void; live: boolean }[] = []
	const feed = createUsageFeed({
		notify: (method, params) => {
			expect(method).toBe(USAGE_NOTIFICATION)
			sent.push(params)
		},
		now: () => clock,
		schedule: (run, ms) => {
			const timer = { at: clock + ms, run, live: true }
			timers.push(timer)
			return () => {
				timer.live = false
			}
		},
	})
	return {
		feed,
		sent,
		advance(ms: number) {
			clock += ms
			for (const timer of timers) {
				if (timer.live && timer.at <= clock) {
					timer.live = false
					timer.run()
				}
			}
		},
		pending: () => timers.filter((timer) => timer.live).length,
	}
}

const usage = (
	contextTokens: number | undefined,
	extra: Record<string, unknown> = {},
): SessionEvent =>
	({
		type: 'token_usage_updated',
		sessionId: 's',
		turnId: 't',
		usage: {},
		cost: { totalCost: 0.5, cacheDiscount: 0, unpricedTokens: 0 },
		...(contextTokens === undefined ? {} : { contextTokens }),
		contextWindowTokens: 200_000,
		contextMeasuredBy: 'provider',
		...extra,
	}) as unknown as SessionEvent

describe('the desktop usage feed', () => {
	it('sends the first usage at once with the context, window and a priced cost', () => {
		const h = harness()
		h.feed.observe('a', usage(1200))
		expect(h.sent).toEqual([
			{
				sessionId: 'a',
				contextTokens: 1200,
				contextWindowTokens: 200_000,
				contextMeasuredBy: 'provider',
				cost: 0.5,
			},
		])
	})

	it('coalesces a burst into the first and one trailing notification with the latest', () => {
		const h = harness()
		h.feed.observe('a', usage(1))
		h.feed.observe('a', usage(2))
		h.feed.observe('a', usage(3))
		expect(h.sent).toHaveLength(1)
		expect(h.pending()).toBe(1)
		h.advance(399)
		expect(h.sent).toHaveLength(1)
		h.advance(1)
		expect(h.sent).toHaveLength(2)
		expect(h.sent[1]?.contextTokens).toBe(3)
		expect(h.pending()).toBe(0)
	})

	it('keeps sessions apart', () => {
		const h = harness()
		h.feed.observe('a', usage(1))
		h.feed.observe('b', usage(2))
		expect(h.sent.map((body) => body.sessionId)).toEqual(['a', 'b'])
	})

	it('sends nothing for an engine that reports no usage', () => {
		const h = harness()
		h.feed.observe('a', { type: 'turn_completed' } as unknown as SessionEvent)
		expect(h.sent).toEqual([])
	})

	it('leaves out cost when any token was unpriced and context when none was measured', () => {
		const h = harness()
		h.feed.observe(
			'a',
			usage(undefined, {
				contextWindowTokens: undefined,
				contextMeasuredBy: undefined,
				cost: { totalCost: 0.5, cacheDiscount: 0, unpricedTokens: 10 },
			}),
		)
		expect(h.sent).toEqual([{ sessionId: 'a' }])
	})

	it('announces compaction start and finish at once, finish carrying the new size', () => {
		const h = harness()
		h.feed.observe('a', usage(150_000))
		h.feed.observe('a', {
			type: 'compaction_started',
			sessionId: 's',
			iteration: 1,
			reason: 'threshold',
			tokensBefore: 150_000,
			contextWindowTokens: 200_000,
		} as unknown as SessionEvent)
		h.feed.observe('a', {
			type: 'compaction_completed',
			sessionId: 's',
			iteration: 1,
			tokensBefore: 150_000,
			tokensAfter: 40_000,
			contextWindowTokens: 200_000,
		} as unknown as SessionEvent)
		expect(h.sent.map((body) => body.compaction)).toEqual([undefined, 'started', 'finished'])
		expect(h.sent[2]).toMatchObject({
			contextTokens: 40_000,
			tokensBefore: 150_000,
			tokensAfter: 40_000,
		})
	})

	it('ends a pass that changed nothing or that only cleared tool results', () => {
		const h = harness()
		h.feed.observe('a', {
			type: 'compaction_failed',
			sessionId: 's',
			iteration: 1,
		} as unknown as SessionEvent)
		h.feed.observe('a', {
			type: 'compaction_tool_results_cleared',
			sessionId: 's',
			reliefWasEnough: false,
		} as unknown as SessionEvent)
		h.feed.observe('a', {
			type: 'compaction_tool_results_cleared',
			sessionId: 's',
			reliefWasEnough: true,
		} as unknown as SessionEvent)
		expect(h.sent.map((body) => body.compaction)).toEqual(['failed', 'finished'])
	})

	it('sends nothing after close, not even a pending trailing notification', () => {
		const h = harness()
		h.feed.observe('a', usage(1))
		h.feed.observe('a', usage(2))
		h.feed.close()
		h.advance(1000)
		h.feed.observe('a', usage(3))
		expect(h.sent).toHaveLength(1)
	})

	it('survives a notify that throws', () => {
		const feed = createUsageFeed({
			notify: () => {
				throw new Error('closed')
			},
			now: () => 0,
			schedule: () => () => {},
		})
		expect(() => feed.observe('a', usage(1))).not.toThrow()
	})

	it('forgets a conversation once its turn has ended and nothing is left to send', () => {
		const h = harness()
		h.feed.observe('a', usage(1200))
		h.feed.observe('a', {
			type: 'turn_completed',
			sessionId: 'a',
		} as unknown as SessionEvent)
		// A new turn with no window of its own starts clean: nothing is carried over.
		h.feed.observe('a', usage(5, { contextWindowTokens: undefined, cost: undefined }))
		expect(h.sent).toHaveLength(2)
		expect(h.sent[1]).toEqual({
			sessionId: 'a',
			contextTokens: 5,
			contextMeasuredBy: 'provider',
		})
	})

	it('still sends the trailing update of a turn that ended inside the window', () => {
		const h = harness()
		h.feed.observe('a', usage(1))
		h.feed.observe('a', usage(2))
		h.feed.observe('a', {
			type: 'turn_completed',
			sessionId: 'a',
		} as unknown as SessionEvent)
		h.advance(1000)
		expect(h.sent.map((body) => body.contextTokens)).toEqual([1, 2])
	})
})
