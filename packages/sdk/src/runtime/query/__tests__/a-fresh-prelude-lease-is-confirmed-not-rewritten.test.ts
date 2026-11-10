import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_TURN_LEASE_TTL_MS } from '../../../manager/session/turn-recorder.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import { PreludeSessionLease } from '../prelude-lease.js'

/**
 * The prelude confirms its writer lease before each side effect. A renewal is
 * a durable rewrite of two files; confirming a lease that is far from expiry
 * only needs the fence read, and a lost holding must still be found.
 */
async function held() {
	const sessionId = generateSessionId()
	const log = new InMemorySessionLog({ sessionId })
	const holding = await PreludeSessionLease.acquire(log, sessionId, generateTurnId())
	return { log, holding }
}

describe('PreludeSessionLease.assertCurrent', () => {
	it('confirms a lease with most of its time left without renewing it', async () => {
		vi.useFakeTimers()
		try {
			const { log, holding } = await held()
			const claim = vi.spyOn(log, 'claim')
			await holding.assertCurrent()
			await holding.assertCurrent()
			expect(claim).not.toHaveBeenCalled()
			const transferred = await holding.transfer()
			expect(transferred.fence).toBe((await log.lease())?.fence)
			await holding.stop()
			await log.release(transferred)
		} finally {
			vi.useRealTimers()
		}
	})

	it('still finds a session that was taken over inside the fresh window', async () => {
		vi.useFakeTimers()
		try {
			const { log, holding } = await held()
			const first = await log.lease()
			if (!first) throw new Error('Could not claim prelude lease')
			await log.release(first)
			await expect(holding.assertCurrent()).rejects.toMatchObject({ code: 'invalid_config' })
			await holding.release()
		} finally {
			vi.useRealTimers()
		}
	})

	it('renews once the holding is past half of its time, as before', async () => {
		vi.useFakeTimers()
		try {
			const { log, holding } = await held()
			const first = await log.lease()
			const claim = vi.spyOn(log, 'claim')
			// The clock moves without running the heartbeat timer, so only the
			// assertion can be the one to renew.
			vi.setSystemTime(Date.now() + DEFAULT_TURN_LEASE_TTL_MS / 2 + 1)
			await holding.assertCurrent()
			expect(claim).toHaveBeenCalledTimes(1)
			const renewed = await log.lease()
			expect(renewed?.fence).toBe(first?.fence)
			expect(renewed?.expiresAt).toBeGreaterThan(first?.expiresAt ?? 0)
			await holding.stop()
			if (renewed) await log.release(renewed)
		} finally {
			vi.useRealTimers()
		}
	})

	it('hands the recorder a full lifetime, not what was left at the last confirmation', async () => {
		vi.useFakeTimers()
		try {
			const { log, holding } = await held()
			const first = await log.lease()
			// Just inside the window where a confirmation only reads: the
			// recorder's heartbeat would not fire until half a lifetime later.
			vi.setSystemTime(Date.now() + DEFAULT_TURN_LEASE_TTL_MS / 2 - 1000)
			const transferred = await holding.transfer()
			expect(transferred.expiresAt - Date.now()).toBe(DEFAULT_TURN_LEASE_TTL_MS)
			expect(transferred.expiresAt).toBeGreaterThan(first?.expiresAt ?? 0)
			await holding.stop()
			await log.release(transferred)
		} finally {
			vi.useRealTimers()
		}
	})
})
