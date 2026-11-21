import { describe, expect, it } from 'vitest'
import { createManualClock } from './clock.js'
import {
	HOLD_EXPIRY_MS,
	HoldQueue,
	LOOP_THRESHOLD,
	type MailDecisionInput,
	SlidingCounter,
	TokenBuckets,
	decideMail,
} from './mail-policy.js'

const base: MailDecisionInput = {
	scope: 'remote',
	text: 'hello',
	hops: 0,
	receiver: { mode: 'auto', bypass: false, accepting: true, setting: 'members' },
	sender: { claimedMode: 'auto', vouchedMode: 'auto' },
	rateOk: true,
	pairCount: 1,
}
type Patch = Omit<Partial<MailDecisionInput>, 'receiver' | 'sender'> & {
	receiver?: Partial<MailDecisionInput['receiver']>
	sender?: Partial<MailDecisionInput['sender']>
}
const decide = (patch: Patch) =>
	decideMail({
		...base,
		...patch,
		receiver: { ...base.receiver, ...patch.receiver },
		sender: { ...base.sender, ...patch.sender },
	})

describe('decideMail', () => {
	it('accepts matching modes', () => expect(decide({})).toEqual({ action: 'accept' }))

	it('holds a different mode instead of refusing, for remote and local senders', () => {
		for (const scope of ['remote', 'local'] as const) {
			const r = decide({ scope, sender: { claimedMode: 'prompt', vouchedMode: 'prompt' } })
			expect(r.action).toBe('hold')
		}
	})

	it('holds when the claimed mode is not the one the sender machine vouches for, or none is known', () => {
		expect(decide({ sender: { claimedMode: 'auto', vouchedMode: 'prompt' } }).action).toBe('hold')
		expect(decide({ sender: { vouchedMode: undefined } }).action).toBe('hold')
		expect(decide({ receiver: { mode: undefined } }).action).toBe('hold')
	})

	it('holds everything for a receiver in bypass, even in the same mode', () => {
		const r = decide({
			receiver: { mode: 'bypassPermissions', bypass: true },
			sender: { claimedMode: 'bypassPermissions', vouchedMode: 'bypassPermissions' },
		})
		expect(r.action).toBe('hold')
		expect(decide({ scope: 'local', receiver: { bypass: true } }).action).toBe('hold')
	})

	it('holds on the hold setting, refuses on off, and only for remote mail', () => {
		expect(decide({ receiver: { setting: 'hold' } }).action).toBe('hold')
		expect(decide({ receiver: { setting: 'off' } }).action).toBe('refuse')
		expect(decide({ scope: 'local', receiver: { setting: 'off' } }).action).toBe('accept')
	})

	it('refuses an empty, oversize, rate-limited or looping-hops message', () => {
		expect(decide({ text: '   ' }).action).toBe('refuse')
		expect(decide({ text: 'x'.repeat(32 * 1024 + 1) }).action).toBe('refuse')
		expect(decide({ rateOk: false }).action).toBe('refuse')
		expect(decide({ hops: 4 }).action).toBe('refuse')
		expect(decide({ hops: 3 }).action).toBe('accept')
		expect(decide({ receiver: { accepting: false } }).action).toBe('refuse')
	})

	it('holds a suspected loop', () => {
		expect(decide({ pairCount: LOOP_THRESHOLD }).action).toBe('accept')
		expect(decide({ pairCount: LOOP_THRESHOLD + 1 }).action).toBe('hold')
	})
})

describe('counters', () => {
	it('empties a bucket and refills it by the clock', () => {
		const clock = createManualClock()
		const b = new TokenBuckets({ capacity: 30, refillPerSecond: 0.5, clock })
		for (let i = 0; i < 30; i++) expect(b.take('m')).toBe(true)
		expect(b.take('m')).toBe(false)
		expect(b.take('other')).toBe(true)
		clock.advance(2000)
		expect(b.take('m')).toBe(true)
		expect(b.take('m')).toBe(false)
	})

	it('counts hits in a sliding window', () => {
		const clock = createManualClock()
		const c = new SlidingCounter(clock, 60_000)
		for (let i = 1; i <= 9; i++) expect(c.record('p')).toBe(i)
		clock.advance(60_000)
		expect(c.record('p')).toBe(1)
	})
})

describe('HoldQueue', () => {
	it('expires held mail by the clock and tells the owner', () => {
		const clock = createManualClock()
		const expired: string[] = []
		const q = new HoldQueue<string>({ clock, onExpire: (id) => expired.push(id) })
		expect(q.hold('a', 'text')).toBe(true)
		clock.advance(HOLD_EXPIRY_MS - 1)
		expect(expired).toEqual([])
		clock.advance(1)
		expect(expired).toEqual(['a'])
		expect(q.size).toBe(0)
		expect(clock.pending).toBe(0)
	})

	it('does not expire what was already released, and is capped', () => {
		const clock = createManualClock()
		const expired: string[] = []
		const q = new HoldQueue<number>({ clock, capacity: 2, onExpire: (id) => expired.push(id) })
		q.hold('a', 1)
		q.hold('b', 2)
		expect(q.hold('c', 3)).toBe(false)
		expect(q.release('a')?.item).toBe(1)
		clock.advance(HOLD_EXPIRY_MS)
		expect(expired).toEqual(['b'])
	})
})
