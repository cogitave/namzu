import { describe, expect, it } from 'vitest'
import type { AccountActivity } from './activity.js'
import { hostAccountFacts } from './host-facts.js'

const NOW = 1_800_000_000_000
const none: AccountActivity = { lastUsed: {}, limitedUntil: {}, mayBeLimited: {}, autoSwitch: {} }

describe('what a hosted terminal tells its host about its account', () => {
	it('says nothing about the usual sign-in', () => {
		expect(
			hostAccountFacts({ accountId: 'openai:default', stopped: false, activity: none, now: NOW }),
		).toEqual({
			limited: false,
		})
		expect(
			hostAccountFacts({ accountId: undefined, stopped: false, activity: none, now: NOW }),
		).toEqual({
			limited: false,
		})
	})

	it('gives the label of another account', () => {
		expect(
			hostAccountFacts({ accountId: 'openai:free-a', stopped: false, activity: none, now: NOW }),
		).toEqual({
			account: 'free-a',
			limited: false,
		})
	})

	it('carries the return time while an allowance is out, and drops it once passed', () => {
		const out = { ...none, limitedUntil: { 'openai:free-a': NOW + 3_600_000 } }
		expect(
			hostAccountFacts({ accountId: 'openai:free-a', stopped: false, activity: out, now: NOW }),
		).toEqual({
			account: 'free-a',
			limited: true,
			limitedUntil: NOW + 3_600_000,
		})
		expect(
			hostAccountFacts({
				accountId: 'openai:free-a',
				stopped: false,
				activity: out,
				now: NOW + 7_200_000,
			}).limited,
		).toBe(false)
	})

	it('says may be limited with no time when the provider gave none, or when stopped on a spent allowance', () => {
		const noted = { ...none, mayBeLimited: { 'openai:free-a': NOW - 1000 } }
		expect(
			hostAccountFacts({ accountId: 'openai:free-a', stopped: false, activity: noted, now: NOW }),
		).toEqual({
			account: 'free-a',
			limited: true,
		})
		expect(
			hostAccountFacts({ accountId: 'openai:free-a', stopped: true, activity: none, now: NOW })
				.limited,
		).toBe(true)
	})
})
