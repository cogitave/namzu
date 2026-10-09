import { describe, expect, it } from 'vitest'
import { clockLabel, daySeparatorLabel, fullTimeLabel } from './time-format.js'

const at = Date.UTC(2026, 9, 9, 6, 27, 50)

describe('one time convention for the transcript', () => {
	it('follows the locale’s own 12- or 24-hour habit in the header, the footer and the tooltip alike', () => {
		const us = { header: daySeparatorLabel(at, 'en-US'), footer: clockLabel(at, 'en-US') }
		const gb = { header: daySeparatorLabel(at, 'en-GB'), footer: clockLabel(at, 'en-GB') }
		const usHas12 = (value: string) => /\b(AM|PM)\b/u.test(value)
		expect([us.header, us.footer, fullTimeLabel(at, 'en-US')].every(usHas12)).toBe(true)
		expect([gb.header, gb.footer, fullTimeLabel(at, 'en-GB')].some(usHas12)).toBe(false)
	})

	it('shows hours and minutes in a footer, never seconds', () => {
		expect(clockLabel(at, 'en-GB')).toMatch(/^\d{1,2}:\d{2}$/u)
		expect(fullTimeLabel(at, 'en-GB')).toMatch(/\d{1,2}:\d{2}:\d{2}/u)
	})

	it('writes the day in the same locale as the clock', () => {
		expect(daySeparatorLabel(at, 'tr-TR')).toContain('Eki')
		expect(clockLabel(at, 'tr-TR')).toMatch(/^\d{1,2}:\d{2}$/u)
	})
})
