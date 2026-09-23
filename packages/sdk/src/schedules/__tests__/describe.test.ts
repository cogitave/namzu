import { describe, expect, it } from 'vitest'
import { describeSchedule } from '../describe.js'

const cron = (expr: string) => describeSchedule({ kind: 'cron', expr, tz: 'UTC' })
const every = (everyMs: number) =>
	describeSchedule({ kind: 'every', everyMs, anchorAt: '2026-09-23T00:00:00.000Z' })

describe('describeSchedule, every shape', () => {
	it('intervals in their largest whole unit', () => {
		expect(every(60_000)).toBe('every minute')
		expect(every(3_600_000)).toBe('every hour')
		expect(every(2 * 3_600_000)).toBe('every 2 hours')
		expect(every(86_400_000)).toBe('every 24 hours')
		expect(every(3 * 86_400_000)).toBe('every 3 days')
		expect(every(7 * 86_400_000)).toBe('every week')
		expect(every(14 * 86_400_000)).toBe('every 2 weeks')
	})

	it('cron times and days', () => {
		expect(cron('* * * * *')).toBe('every minute every day (UTC)')
		expect(cron('0,30 * * * *')).toBe('every hour at minute 0, 30 every day (UTC)')
		expect(cron('15 */2 * * *')).toBe('every 2 hours at minute 15 every day (UTC)')
		expect(cron('0 8,12,18 * * *')).toBe('at 08:00, 12:00, 18:00 every day (UTC)')
		expect(cron('5 1-12 * * *')).toBe('at minute 5 of hour 1 through 12 every day (UTC)')
		expect(cron('0 0 1,15 * *')).toBe('at 00:00 on day 1, 15 of the month (UTC)')
		expect(cron('0 0 1 1,2,3,7 *')).toBe(
			'at 00:00 on day 1 of the month in January through March, July (UTC)',
		)
		expect(cron('0 0 13 * 5')).toBe('at 00:00 on day 13 of the month and on Friday (UTC)')
		expect(cron('0 0 * * 0,6')).toBe('at 00:00 on Sunday, Saturday (UTC)')
	})

	it('falls back to the expression rather than paraphrase what it cannot parse', () => {
		expect(cron('bogus')).toBe('cron "bogus" (UTC)')
	})
})
