import { describe, expect, it } from 'vitest'
import type { RecoveryCause } from './recovery-card.js'
import {
	HANG_GRACE_MS,
	RELOAD_WINDOW_MS,
	type RecoveryTimers,
	WindowRecovery,
} from './window-recovery.js'

/** A clock that only moves when the test says so. */
function fakeTimers() {
	let now = 1_000
	let pending: { at: number; run: () => void; live: boolean }[] = []
	const timers: RecoveryTimers = {
		now: () => now,
		after(ms, run) {
			const entry = { at: now + ms, run, live: true }
			pending.push(entry)
			return () => {
				entry.live = false
			}
		},
	}
	return {
		timers,
		advance(ms: number) {
			const target = now + ms
			for (;;) {
				const due = pending
					.filter((entry) => entry.live && entry.at <= target)
					.sort((a, b) => a.at - b.at)[0]
				if (!due) break
				now = due.at
				due.live = false
				due.run()
			}
			now = target
			pending = pending.filter((entry) => entry.live)
		},
	}
}

function setup() {
	const clock = fakeTimers()
	const log = { reloads: 0, ended: 0, hangs: 0, cards: [] as RecoveryCause[], closed: false }
	const recovery = new WindowRecovery({
		timers: clock.timers,
		reload: () => {
			log.reloads += 1
		},
		showCard: (cause) => log.cards.push(cause),
		hangExpired: () => {
			log.hangs += 1
		},
		endProcess: () => {
			log.ended += 1
		},
		closed: () => log.closed,
	})
	return { clock, log, recovery }
}

describe('WindowRecovery crash handling', () => {
	it('reloads after 0.5, 2 and 10 seconds, then shows the card on the fourth crash', () => {
		const { clock, log, recovery } = setup()
		recovery.processGone('crashed', 5)
		clock.advance(499)
		expect(log.reloads).toBe(0)
		clock.advance(1)
		expect(log.reloads).toBe(1)
		recovery.processGone('crashed', 5)
		clock.advance(1_999)
		expect(log.reloads).toBe(1)
		clock.advance(1)
		expect(log.reloads).toBe(2)
		recovery.processGone('crashed', 5)
		clock.advance(9_999)
		expect(log.reloads).toBe(2)
		clock.advance(1)
		expect(log.reloads).toBe(3)
		recovery.processGone('oom', 9)
		clock.advance(60_000)
		expect(log.reloads).toBe(3)
		expect(log.cards).toEqual([{ kind: 'crashed', reason: 'oom', exitCode: 9, reloads: 3 }])
		expect(recovery.cardShowing).toBe(true)
	})

	it('forgets reloads older than a minute', () => {
		const { clock, log, recovery } = setup()
		for (let index = 0; index < 3; index++) {
			recovery.processGone('crashed', 1)
			clock.advance(10_000)
		}
		expect(log.reloads).toBe(3)
		clock.advance(RELOAD_WINDOW_MS)
		recovery.processGone('crashed', 1)
		clock.advance(500)
		expect(log.reloads).toBe(4)
		expect(log.cards).toEqual([])
	})

	it('ignores a clean exit', () => {
		const { clock, log, recovery } = setup()
		recovery.processGone('clean-exit', 0)
		clock.advance(60_000)
		expect(log).toMatchObject({ reloads: 0, cards: [] })
	})

	it('does not reload a window that has closed', () => {
		const { clock, log, recovery } = setup()
		recovery.processGone('crashed', 1)
		log.closed = true
		clock.advance(60_000)
		expect(log.reloads).toBe(0)
	})

	it('stops pending work on dispose', () => {
		const { clock, log, recovery } = setup()
		recovery.processGone('crashed', 1)
		recovery.unresponsive()
		recovery.dispose()
		clock.advance(60_000)
		expect(log).toMatchObject({ reloads: 0, ended: 0 })
	})
})

describe('WindowRecovery hang handling', () => {
	it('ends the process only after the grace period, then reloads as for a crash', () => {
		const { clock, log, recovery } = setup()
		recovery.unresponsive()
		clock.advance(HANG_GRACE_MS - 1)
		expect(log.ended).toBe(0)
		clock.advance(1)
		expect(log.ended).toBe(1)
		recovery.processGone('crashed', 0)
		clock.advance(500)
		expect(log.reloads).toBe(1)
	})

	it('leaves a window that answers again alone', () => {
		const { clock, log, recovery } = setup()
		recovery.unresponsive()
		clock.advance(HANG_GRACE_MS - 1)
		recovery.responsive()
		clock.advance(HANG_GRACE_MS * 2)
		expect(log.ended).toBe(0)
	})

	it('counts a repeated unresponsive event once', () => {
		const { clock, log, recovery } = setup()
		recovery.unresponsive()
		clock.advance(HANG_GRACE_MS / 2)
		recovery.unresponsive()
		clock.advance(HANG_GRACE_MS / 2)
		expect(log.ended).toBe(1)
	})

	it('names a hang on the card once reloads run out', () => {
		const { clock, log, recovery } = setup()
		for (let index = 0; index < 3; index++) {
			recovery.processGone('crashed', 1)
			clock.advance(10_000)
		}
		recovery.unresponsive()
		clock.advance(HANG_GRACE_MS)
		recovery.processGone('killed', 0)
		expect(log.cards).toEqual([{ kind: 'hung', reloads: 3 }])
	})

	it('writes the hang down once, when the grace period runs out and not before', () => {
		const { clock, log, recovery } = setup()
		recovery.unresponsive()
		clock.advance(HANG_GRACE_MS - 1)
		expect(log.hangs).toBe(0)
		clock.advance(1)
		expect(log.hangs).toBe(1)
		expect(log.ended).toBe(1)
	})

	it('reloads when the process cannot be ended because it is already gone', () => {
		const clock = fakeTimers()
		let reloads = 0
		const recovery = new WindowRecovery({
			timers: clock.timers,
			reload: () => {
				reloads += 1
			},
			showCard: () => undefined,
			hangExpired: () => undefined,
			endProcess: () => {
				throw new Error('gone')
			},
			closed: () => false,
		})
		recovery.unresponsive()
		clock.advance(HANG_GRACE_MS)
		clock.advance(500)
		expect(reloads).toBe(1)
	})
})

describe('WindowRecovery load failure and the card', () => {
	it('shows the card at once for a failed load and ignores a cancelled one', () => {
		const { log, recovery } = setup()
		recovery.loadFailed(-3)
		expect(log.cards).toEqual([])
		recovery.loadFailed(-6)
		expect(log.cards).toEqual([{ kind: 'load-failed', errorCode: -6 }])
	})

	it('honours the Reload link only while the card shows, and starts the count again', () => {
		const { clock, log, recovery } = setup()
		expect(recovery.navigation('namzu-recovery://reload')).toBe(true)
		expect(log.reloads).toBe(0)
		expect(recovery.navigation('https://example.com/')).toBe(false)
		for (let index = 0; index < 3; index++) {
			recovery.processGone('crashed', 1)
			clock.advance(10_000)
		}
		recovery.processGone('crashed', 1)
		expect(recovery.cardShowing).toBe(true)
		expect(recovery.navigation('namzu-recovery://reload')).toBe(true)
		expect(log.reloads).toBe(4)
		expect(recovery.cardShowing).toBe(false)
		recovery.processGone('crashed', 1)
		clock.advance(500)
		expect(log.reloads).toBe(5)
	})
})
