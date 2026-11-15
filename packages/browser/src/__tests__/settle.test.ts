import { describe, expect, it } from 'vitest'
import { type SettleClock, type SettleProbe, waitUntilQuiet } from '../settle.js'

/** A clock that only moves when the code under test sleeps, so no test waits on real time. */
function fakeClock(): SettleClock & { time: number } {
	const clock = {
		time: 0,
		now: () => clock.time,
		sleep: async (ms: number) => {
			clock.time += ms
		},
	}
	return clock
}

/** A page that was last active at the given times; stillness is measured from the latest one before now. */
function page(clock: SettleClock, activeAt: readonly number[], inflightUntil = -1): SettleProbe {
	return {
		stillForMs: async () => {
			if (clock.now() < inflightUntil) return 0
			const last = Math.max(-1e9, inflightUntil, ...activeAt.filter((t) => t <= clock.now()))
			return clock.now() - last
		},
	}
}

describe('waitUntilQuiet', () => {
	it('returns after the quiet window when the page is already still', async () => {
		const clock = fakeClock()
		const out = await waitUntilQuiet(clock, page(clock, []), { quietMs: 250, capMs: 2000 })
		expect(out).toEqual({ quiet: true, waitedMs: 250, capMs: 2000 })
	})

	it('never counts stillness from before the wait began', async () => {
		const clock = fakeClock()
		clock.time = 10_000
		const probe: SettleProbe = { stillForMs: async () => 99_999 }
		const out = await waitUntilQuiet(clock, probe, { quietMs: 250, capMs: 2000 })
		expect(out.quiet).toBe(true)
		expect(out.waitedMs).toBeGreaterThanOrEqual(250)
	})

	it('waits out later activity: a change at 300 ms ends the wait no earlier than 550 ms', async () => {
		const clock = fakeClock()
		const out = await waitUntilQuiet(clock, page(clock, [100, 300]), { quietMs: 250, capMs: 2000 })
		expect(out.quiet).toBe(true)
		expect(out.waitedMs).toBeGreaterThanOrEqual(550)
		expect(out.waitedMs).toBeLessThan(2000)
	})

	it('treats a request in flight as not quiet until it ends', async () => {
		const clock = fakeClock()
		const out = await waitUntilQuiet(clock, page(clock, [], 1200), { quietMs: 250, capMs: 5000 })
		expect(out.quiet).toBe(true)
		expect(out.waitedMs).toBeGreaterThanOrEqual(1450)
	})

	it('stops at the cap on a page that never goes quiet, and says so', async () => {
		const clock = fakeClock()
		const busy: SettleProbe = { stillForMs: async () => 0 }
		const out = await waitUntilQuiet(clock, busy, { quietMs: 250, capMs: 2000 })
		expect(out.quiet).toBe(false)
		expect(out.capMs).toBe(2000)
		expect(out.waitedMs).toBeGreaterThanOrEqual(2000)
		expect(out.waitedMs).toBeLessThan(2100)
	})
})
