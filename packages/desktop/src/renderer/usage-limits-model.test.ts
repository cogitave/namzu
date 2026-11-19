import { describe, expect, it } from 'vitest'
import type { LimitsNotification } from '../shared/limits-protocol.js'
import {
	LIMITS_REFRESH_MS,
	asOfText,
	createLimitsRefresher,
	limitTone,
	readBudgets,
	resetText,
	usageLimitsModel,
	writeBudgets,
} from './usage-limits-model.js'

// 2026-11-17 12:00 UTC, read in a fixed zone so the words do not depend on the machine.
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)
const ZONE = 'UTC'
const at = (hours: number, minutes = 0, days = 0) =>
	Date.UTC(2026, 10, 17 + days, hours, minutes, 0)

describe('the ring tone', () => {
	it('turns at 75 percent, is critical at 90, and a rejected window reads full', () => {
		expect(limitTone(0.74)).toBe('normal')
		expect(limitTone(0.75)).toBe('high')
		expect(limitTone(0.89)).toBe('high')
		expect(limitTone(0.9)).toBe('full')
		expect(limitTone(0.1, true)).toBe('full')
	})
})

describe('the reset text', () => {
	it('says the time within a day and the weekday beyond it', () => {
		expect(resetText(at(15), NOW, ZONE)).toBe('Resets at 3:00 PM')
		expect(resetText(at(12, 0, 1), NOW, ZONE)).toBe('Resets at 12:00 PM')
		expect(resetText(at(14, 0, 4), NOW, ZONE)).toBe('Resets Sat 2:00 PM')
	})
	it('reads in the zone it is given', () => {
		expect(resetText(at(15), NOW, 'Europe/Istanbul')).toBe('Resets at 6:00 PM')
	})
})

describe('how old a reading is', () => {
	it('says nothing for a fresh one and the age for an old one', () => {
		expect(asOfText(NOW - 60_000, NOW)).toBeUndefined()
		expect(asOfText(NOW - 12 * 60_000, NOW)).toBe('as of 12 min ago')
		expect(asOfText(NOW - 3 * 3600_000, NOW)).toBe('as of 3 hours ago')
		expect(asOfText(undefined, NOW)).toBeUndefined()
	})
})

const subscription: LimitsNotification = {
	providers: [
		{
			provider: 'anthropic',
			label: 'Anthropic',
			kind: 'sign-in',
			plan: 'Team',
			asOf: NOW,
			windows: [
				{ label: '5-hour limit', usedFraction: 0.27, resetsAt: at(15) },
				{ label: 'Weekly · all models', usedFraction: 0.05, resetsAt: at(14, 0, 4) },
			],
		},
	],
}

describe('the rows', () => {
	it('draws a window row per window with its percent and reset, and the plan only when given', () => {
		const model = usageLimitsModel({ view: subscription, now: NOW, timeZone: ZONE })
		expect(model.sections[0]?.title).toBe('Anthropic · Team')
		const [five, week] = model.sections[0]?.rows ?? []
		expect(five).toMatchObject({
			shape: 'window',
			percent: '27%',
			reset: 'Resets at 3:00 PM',
			tone: 'normal',
		})
		expect(week).toMatchObject({ percent: '5%', reset: 'Resets Sat 2:00 PM' })
		expect(model.tone).toBe('normal')
		expect(model.worst).toBeCloseTo(0.27)
		const noPlan = usageLimitsModel({
			view: { providers: [{ ...(subscription.providers[0] as object), plan: undefined } as never] },
			now: NOW,
			timeZone: ZONE,
		})
		expect(noPlan.sections[0]?.title).toBe('Anthropic')
	})

	it('turns the indicator at 75 and 90, names the state, and says one quiet line when critical', () => {
		const view = (used: number, rejected = false): LimitsNotification => ({
			providers: [
				{
					provider: 'anthropic',
					label: 'Anthropic',
					kind: 'sign-in',
					windows: [
						{
							label: '5-hour limit',
							usedFraction: used,
							resetsAt: at(15),
							...(rejected ? { rejected: true } : {}),
						},
					],
				},
			],
		})
		const high = usageLimitsModel({ view: view(0.8), now: NOW, timeZone: ZONE })
		expect(high.tone).toBe('high')
		expect(high.sections[0]?.rows[0]).toMatchObject({ state: 'Getting close' })
		expect(high.critical).toBeUndefined()
		const full = usageLimitsModel({ view: view(0.96), now: NOW, timeZone: ZONE })
		expect(full.tone).toBe('full')
		expect(full.critical).toBe('5-hour limit is at 96%, resets at 3:00 PM')
		const rejected = usageLimitsModel({ view: view(0.2, true), now: NOW, timeZone: ZONE })
		expect(rejected.sections[0]?.rows[0]).toMatchObject({
			percent: '100%',
			state: 'Limit reached',
			tone: 'full',
		})
		expect(rejected.tone).toBe('full')
	})

	it('does not stand behind a number for a window that has reset since the reading', () => {
		const old: LimitsNotification = {
			providers: [
				{
					provider: 'anthropic',
					label: 'Anthropic',
					kind: 'sign-in',
					windows: [{ label: '5-hour limit', usedFraction: 0.95, resetsAt: NOW - 1000 }],
				},
			],
		}
		const model = usageLimitsModel({ view: old, now: NOW, timeZone: ZONE })
		const row = model.sections[0]?.rows[0]
		expect(row).toMatchObject({ stale: true, fraction: 0 })
		expect(row).not.toHaveProperty('percent')
		expect(model.tone).toBe('normal')
		expect(model.critical).toBeUndefined()
	})

	it('says how old an old reading is', () => {
		const old: LimitsNotification = {
			providers: [
				{
					provider: 'anthropic',
					label: 'Anthropic',
					kind: 'sign-in',
					asOf: NOW - 20 * 60_000,
					windows: [{ label: 'w', usedFraction: 0.1, resetsAt: at(15) }],
				},
			],
		}
		expect(usageLimitsModel({ view: old, now: NOW }).sections[0]?.rows[0]).toMatchObject({
			asOf: 'as of 20 min ago',
		})
	})

	it('draws a spend row as an estimate, with "of budget" only when one is set', () => {
		const view: LimitsNotification = {
			providers: [
				{
					provider: 'keyed',
					label: 'OpenAI',
					kind: 'key',
					spend: { usd: 3.1, days: 30, partial: false },
				},
			],
		}
		const plain = usageLimitsModel({ view, now: NOW })
		expect(plain.sections[0]?.rows[0]).toMatchObject({
			shape: 'spend',
			text: 'Spent about $3.10 in the last 30 days (list prices)',
		})
		expect(plain.sections[0]?.rows[0]).not.toHaveProperty('fraction')
		const budgeted = usageLimitsModel({ view, now: NOW, budgets: { keyed: 4 } })
		expect(budgeted.sections[0]?.rows[0]).toMatchObject({
			text: 'Spent about $3.10 of $4.00 budget in the last 30 days (list prices)',
			tone: 'high',
		})
		expect(budgeted.tone).toBe('high')
		const partial = usageLimitsModel({
			view: {
				providers: [
					{ ...(view.providers[0] as object), spend: { usd: 1, days: 30, partial: true } } as never,
				],
			},
			now: NOW,
		})
		expect(partial.sections[0]?.rows[0]).toMatchObject({
			text: 'Spent at least $1.00 in the last 30 days (list prices)',
		})
	})

	it('draws a credit row: a balance, a use against a limit, or use alone', () => {
		const rows = (credit: object) =>
			usageLimitsModel({
				view: { providers: [{ provider: 'x', label: 'X', kind: 'key', credit } as never] },
				now: NOW,
			}).sections[0]?.rows[0]
		expect(rows({ currency: 'CNY', remaining: 110 })).toMatchObject({
			shape: 'credit',
			text: 'Balance 110.00 CNY',
		})
		expect(rows({ currency: 'USD', used: 3.1, limit: 10 })).toMatchObject({
			text: 'Credit used $3.10 of $10.00',
			fraction: 0.31,
		})
		expect(rows({ currency: 'credits', used: 1.5 })).toMatchObject({ text: 'Used 1.5 credits' })
	})

	it('says one quiet line, never a bar or a zero, for a provider that reports nothing', () => {
		const view: LimitsNotification = {
			providers: [{ provider: 'google', label: 'Google', kind: 'key' }],
		}
		const model = usageLimitsModel({ view, now: NOW })
		expect(model.sections[0]?.rows).toEqual([
			{
				shape: 'none',
				key: 'google:none',
				text: 'Google: usage limits are not reported for this sign-in.',
			},
		])
		expect(model.worst).toBeUndefined()
		expect(model.tone).toBe('normal')
	})

	it('lists the conversation’s own provider first', () => {
		const view: LimitsNotification = {
			providers: [
				{ provider: 'a', label: 'A', kind: 'key' },
				{ provider: 'b', label: 'B', kind: 'key' },
			],
		}
		expect(
			usageLimitsModel({ view, now: NOW, currentProvider: 'b' }).sections.map((s) => s.provider),
		).toEqual(['b', 'a'])
		expect(usageLimitsModel({ view: undefined, now: NOW }).sections).toEqual([])
	})
})

describe('asking the vendor', () => {
	it('lets at most one request through in a minute', async () => {
		let now = 5000
		let calls = 0
		const refresher = createLimitsRefresher({ request: async () => ++calls, now: () => now })
		expect(await refresher.refresh()).toBe(1)
		now += LIMITS_REFRESH_MS - 1
		expect(refresher.refresh()).toBeUndefined()
		now += 1
		expect(await refresher.refresh()).toBe(2)
		expect(calls).toBe(2)
	})
})

describe('budgets', () => {
	it('keep only positive numbers, and survive a blocked store', () => {
		const data = new Map<string, string>()
		const store = {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => void data.set(k, v),
		}
		expect(readBudgets(store)).toEqual({})
		writeBudgets(store, { keyed: 5 })
		expect(readBudgets(store)).toEqual({ keyed: 5 })
		data.set('namzu.limit-budgets', JSON.stringify({ a: -1, b: 'x', c: 2, d: null }))
		expect(readBudgets(store)).toEqual({ c: 2 })
		data.set('namzu.limit-budgets', 'not json')
		expect(readBudgets(store)).toEqual({})
		const blocked = {
			getItem: () => {
				throw new Error('x')
			},
			setItem: () => {
				throw new Error('x')
			},
		}
		expect(readBudgets(blocked)).toEqual({})
		expect(() => writeBudgets(blocked, { a: 1 })).not.toThrow()
	})
})
