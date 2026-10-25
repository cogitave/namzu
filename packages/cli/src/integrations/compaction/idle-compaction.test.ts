import { describe, expect, it, vi } from 'vitest'

import {
	IDLE_COMPACTION_DEFAULT_MIN_TOKENS,
	IdleCompactor,
	type IdleCompactorDeps,
	resolveIdleCompactionMinTokens,
} from './idle-compaction.js'

const HOUR = 3_600_000
const MINUTE = 60_000

/**
 * A clock and a timer the test turns by hand: nothing here waits for real
 * time, so no assertion depends on how fast the host is.
 */
function harness(overrides: Partial<IdleCompactorDeps> = {}) {
	const world = {
		now: 1_000_000,
		enabled: true,
		key: 'conversation-1',
		minTokens: 200_000,
		context: 300_000 as number | undefined,
		nearLimit: false,
		interactedAt: 0,
		running: false,
		dialog: false,
		pendingWake: false,
		background: false,
	}
	let pending: { run: () => void; ms: number } | null = null
	let timersSet = 0
	const compact = vi.fn(async () => true)
	const reports: string[] = []
	const compactor = new IdleCompactor({
		now: () => world.now,
		setTimer: (run, ms) => {
			pending = { run, ms }
			timersSet += 1
			return pending
		},
		clearTimer: (handle) => {
			if (pending === handle) pending = null
		},
		isEnabled: () => world.enabled,
		conversationKey: () => world.key,
		minTokens: () => world.minTokens,
		contextTokens: () => world.context,
		isNearLimit: () => world.nearLimit,
		lastInteractionAt: () => world.interactedAt,
		isTurnRunning: () => world.running,
		isDialogOpen: () => world.dialog,
		hasPendingWake: () => world.pendingWake,
		hasBackgroundWork: () => world.background,
		compact,
		report: (outcome) => reports.push(outcome),
		...overrides,
	})
	/** The turn ended with a one-hour cache that was written or read. */
	const endTurn = (
		cache: { ttlMs: number; touched: boolean } | null = { ttlMs: HOUR, touched: true },
	) => {
		compactor.recordCall(cache ?? undefined)
		compactor.turnSettled()
	}
	/** Let the armed timer fire, `lateBy` after it was due. */
	const fire = async (lateBy = 0) => {
		const timer = pending as { run: () => void; ms: number } | null
		if (!timer) throw new Error('nothing armed')
		world.now += timer.ms + lateBy
		pending = null
		timer.run()
		await vi.waitFor(() => expect(reports.length).toBeGreaterThan(0))
	}
	return {
		compactor,
		world,
		compact,
		reports,
		endTurn,
		fire,
		armed: () => pending as { ms: number } | null,
		timersSet: () => timersSet,
	}
}

describe('idle compaction', () => {
	it('arms for 90% of the one-hour cache and compacts when everything holds', async () => {
		const h = harness()
		h.endTurn()
		expect(h.armed()?.ms).toBe(0.9 * HOUR)
		await h.fire()
		expect(h.compact).toHaveBeenCalledOnce()
		expect(h.reports).toEqual(['compacted'])
	})

	it('is one-shot: nothing fires a second time', async () => {
		const h = harness()
		h.endTurn()
		await h.fire()
		expect(h.armed()).toBeNull()
		expect(h.compact).toHaveBeenCalledOnce()
	})

	it('replaces the earlier timer when the next turn ends', () => {
		const h = harness()
		h.endTurn()
		h.world.now += 10 * MINUTE
		h.endTurn()
		expect(h.timersSet()).toBe(2)
		expect(h.armed()?.ms).toBe(0.9 * HOUR)
	})

	it('never arms for a five-minute cache, an unknown lifetime or an untouched cache', () => {
		const h = harness()
		h.endTurn({ ttlMs: 5 * MINUTE, touched: true })
		expect(h.armed()).toBeNull()
		h.endTurn(null)
		expect(h.armed()).toBeNull()
		h.endTurn({ ttlMs: HOUR, touched: false })
		expect(h.armed()).toBeNull()
	})

	it('never arms while the setting is off', () => {
		const h = harness()
		h.world.enabled = false
		h.endTurn()
		expect(h.armed()).toBeNull()
	})

	const skips: [string, (h: ReturnType<typeof harness>) => void, string, number?][] = [
		[
			'the setting was turned off',
			(h) => {
				h.world.enabled = false
			},
			'disabled',
		],
		[
			'the conversation or model changed',
			(h) => {
				h.world.key = 'other'
			},
			'conversation-changed',
		],
		[
			'the context is under the minimum',
			(h) => {
				h.world.context = 199_999
			},
			'small',
		],
		[
			'the context size is unknown',
			(h) => {
				h.world.context = undefined
			},
			'small',
		],
		[
			'a request was sent since the turn ended',
			(h) => h.compactor.requestStarted(),
			'newer-request',
		],
		[
			'the provider reports a usage limit close',
			(h) => {
				h.world.nearLimit = true
			},
			'near-limit',
		],
		[
			'a turn is running',
			(h) => {
				h.world.running = true
			},
			'busy',
		],
		[
			'a dialog is open',
			(h) => {
				h.world.dialog = true
			},
			'busy',
		],
		[
			'a message is queued',
			(h) => {
				h.world.pendingWake = true
			},
			'busy',
		],
		[
			'background work runs',
			(h) => {
				h.world.background = true
			},
			'busy',
		],
		[
			'the person was at the keyboard within a minute',
			(h) => {
				h.world.interactedAt = h.world.now + 0.9 * HOUR - 30_000
			},
			'present',
		],
	]
	for (const [name, arrange, reason] of skips) {
		it(`stays out of the way when ${name}`, async () => {
			const h = harness()
			h.endTurn()
			arrange(h)
			await h.fire()
			expect(h.compact).not.toHaveBeenCalled()
			expect(h.reports).toEqual([reason])
		})
	}

	it('stays out of the way when the timer ran more than a minute late', async () => {
		const h = harness()
		h.endTurn()
		await h.fire(MINUTE + 1)
		expect(h.compact).not.toHaveBeenCalled()
		expect(h.reports).toEqual(['late'])
	})

	it('still acts when the timer ran exactly a minute late', async () => {
		const h = harness()
		h.endTurn()
		await h.fire(MINUTE)
		expect(h.compact).toHaveBeenCalledOnce()
	})

	it('forgets the cache when the context was rewritten', () => {
		const h = harness()
		h.endTurn()
		h.compactor.contextChanged()
		expect(h.armed()).toBeNull()
	})

	it('reports a failed attempt instead of throwing, and does not retry', async () => {
		const h = harness({
			compact: vi.fn(async () => {
				throw new Error('boom')
			}),
		})
		h.endTurn()
		await h.fire()
		expect(h.reports).toEqual(['failed'])
		expect(h.armed()).toBeNull()
	})

	it('reports a conversation too short to compact', async () => {
		const h = harness({ compact: vi.fn(async () => false) })
		h.endTurn()
		await h.fire()
		expect(h.reports).toEqual(['nothing-to-compact'])
	})
})

describe('the minimum context', () => {
	it('defaults to 200,000 tokens', () => {
		expect(resolveIdleCompactionMinTokens()).toBe(IDLE_COMPACTION_DEFAULT_MIN_TOKENS)
	})
	it('takes the first usable candidate and never goes under 100,000', () => {
		expect(resolveIdleCompactionMinTokens('300000', 250_000)).toBe(300_000)
		expect(resolveIdleCompactionMinTokens('nope', 250_000)).toBe(250_000)
		expect(resolveIdleCompactionMinTokens(50_000)).toBe(100_000)
		expect(resolveIdleCompactionMinTokens(0, undefined)).toBe(IDLE_COMPACTION_DEFAULT_MIN_TOKENS)
	})
})
