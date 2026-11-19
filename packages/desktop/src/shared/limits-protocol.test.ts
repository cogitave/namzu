import { describe, expect, it } from 'vitest'
import { readLimitsNotice } from './limits-protocol.js'

describe('readLimitsNotice', () => {
	it('keeps the known fields and clamps a fraction into 0 to 1', () => {
		const out = readLimitsNotice({
			providers: [
				{
					provider: 'anthropic',
					label: 'Anthropic',
					kind: 'sign-in',
					plan: 'Team',
					secret: 'dropped',
					windows: [
						{ label: '5-hour limit', usedFraction: 1.4, resetsAt: 5, extra: 1 },
						{ label: 'low', usedFraction: -2 },
					],
					asOf: 9,
				},
			],
		})
		expect(out).toEqual({
			providers: [
				{
					provider: 'anthropic',
					label: 'Anthropic',
					kind: 'sign-in',
					plan: 'Team',
					windows: [
						{ label: '5-hour limit', usedFraction: 1, resetsAt: 5 },
						{ label: 'low', usedFraction: 0 },
					],
					asOf: 9,
				},
			],
		})
	})

	it('ignores frames and entries that do not read', () => {
		for (const bad of [null, 'x', 3, [], {}, { providers: 'x' }])
			expect(readLimitsNotice(bad)).toBeUndefined()
		const out = readLimitsNotice({
			providers: [
				null,
				{ provider: 'a', label: 'A', kind: 'weird' },
				{ provider: '', label: 'A', kind: 'key' },
				{
					provider: 'ok',
					label: 'Ok',
					kind: 'key',
					windows: [{ label: 'w', usedFraction: 'x' }, { usedFraction: 0.1 }],
					credit: { currency: 'USD' },
					spend: { usd: -1, days: 30 },
				},
			],
		})
		expect(out).toEqual({ providers: [{ provider: 'ok', label: 'Ok', kind: 'key' }] })
	})

	it('drops bad numbers instead of reading them as zero', () => {
		const out = readLimitsNotice({
			providers: [
				{
					provider: 'p',
					label: 'P',
					kind: 'key',
					credit: { currency: 'USD', used: Number.NaN, remaining: 4 },
					spend: { usd: 1e13, days: 30 },
				},
			],
		})
		expect(out?.providers[0]?.credit).toEqual({ currency: 'USD', remaining: 4 })
		expect(out?.providers[0]).not.toHaveProperty('spend')
	})

	it('strips control characters and caps the lists', () => {
		const providers = Array.from({ length: 30 }, (_, i) => ({
			provider: `p${i}`,
			label: `L\u0007${i}`,
			kind: 'local',
		}))
		const out = readLimitsNotice({ providers })
		expect(out?.providers).toHaveLength(12)
		expect(out?.providers[0]?.label).toBe('L 0')
	})
})
