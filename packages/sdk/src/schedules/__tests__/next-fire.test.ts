import { describe, expect, it } from 'vitest'
import { ScheduleValidationError } from '../errors.js'
import { countOccurrences, nextFireTime, previousFireTime } from '../next-fire.js'
import { parseScheduleSpec } from '../spec.js'
import type { ScheduleSpec } from '../types.js'
import { formatWall } from '../tz.js'

const cron = (expr: string, tz: string): ScheduleSpec => ({ kind: 'cron', expr, tz })

/** The next `n` fire times after `from`, as local wall strings. */
function walk(spec: ScheduleSpec, from: string, n: number, tz: string): string[] {
	const out: string[] = []
	let cursor = new Date(from)
	for (let i = 0; i < n; i++) {
		const next = nextFireTime(spec, cursor)
		if (!next) break
		out.push(`${formatWall(next.getTime(), tz)} ${next.toISOString()}`)
		cursor = next
	}
	return out
}

describe('nextFireTime: golden tables', () => {
	it('UTC, daily and the DOM/DOW OR rule', () => {
		expect(
			nextFireTime(cron('0 3 * * *', 'UTC'), new Date('2026-09-23T10:00:00Z'))?.toISOString(),
		).toBe('2026-09-24T03:00:00.000Z')
		// The 13th OR a Friday.
		const hits = walk(cron('0 0 13 * 5', 'UTC'), '2026-11-01T00:00:00Z', 5, 'UTC').map((s) =>
			s.slice(0, 10),
		)
		expect(hits).toEqual(['2026-11-06', '2026-11-13', '2026-11-20', '2026-11-27', '2026-12-04'])
	})

	it('Europe/Istanbul has no DST (UTC+3 all year)', () => {
		const next = nextFireTime(
			cron('0 9 * * *', 'Europe/Istanbul'),
			new Date('2026-12-31T12:00:00Z'),
		)
		expect(next?.toISOString()).toBe('2027-01-01T06:00:00.000Z')
	})

	it('America/New_York spring forward: a fixed 02:30 fires once at 03:00', () => {
		const out = walk(
			cron('30 2 * * *', 'America/New_York'),
			'2027-03-13T12:00:00Z',
			2,
			'America/New_York',
		)
		expect(out[0]).toBe('2027-03-14 03:00 2027-03-14T07:00:00.000Z')
		expect(out[1]).toBe('2027-03-15 02:30 2027-03-15T06:30:00.000Z')
	})

	it('America/New_York spring forward: a wildcard expression skips the missing hour', () => {
		const out = walk(
			cron('30 * * * *', 'America/New_York'),
			'2027-03-14T05:45:00Z',
			3,
			'America/New_York',
		)
		expect(out.map((s) => s.slice(0, 16))).toEqual([
			'2027-03-14 01:30',
			'2027-03-14 03:30',
			'2027-03-14 04:30',
		])
	})

	it('America/New_York fall back: a fixed 01:30 fires once, at the first 01:30', () => {
		const out = walk(
			cron('30 1 * * *', 'America/New_York'),
			'2026-10-31T12:00:00Z',
			2,
			'America/New_York',
		)
		expect(out[0]).toBe('2026-11-01 01:30 2026-11-01T05:30:00.000Z')
		expect(out[1]?.slice(0, 16)).toBe('2026-11-02 01:30')
	})

	it('America/New_York fall back: an hourly expression fires twice in the repeated hour', () => {
		const out = walk(
			cron('0 * * * *', 'America/New_York'),
			'2026-11-01T03:30:00Z',
			4,
			'America/New_York',
		)
		expect(out).toEqual([
			'2026-11-01 00:00 2026-11-01T04:00:00.000Z',
			'2026-11-01 01:00 2026-11-01T05:00:00.000Z',
			'2026-11-01 01:00 2026-11-01T06:00:00.000Z',
			'2026-11-01 02:00 2026-11-01T07:00:00.000Z',
		])
	})

	it('Australia/Lord_Howe shifts by thirty minutes', () => {
		// DST starts first Sunday of October 2026 (Oct 4): 02:00 → 02:30.
		const out = walk(
			cron('15 2 * * *', 'Australia/Lord_Howe'),
			'2026-10-03T00:00:00Z',
			1,
			'Australia/Lord_Howe',
		)
		expect(out[0]?.slice(0, 16)).toBe('2026-10-04 02:30')
	})

	it('Asia/Kathmandu is +05:45', () => {
		const next = nextFireTime(cron('0 9 * * *', 'Asia/Kathmandu'), new Date('2026-09-23T00:00:00Z'))
		expect(next?.toISOString()).toBe('2026-09-23T03:15:00.000Z')
	})

	it('Feb 29 waits for a leap year; the 31st skips short months', () => {
		expect(
			nextFireTime(cron('0 0 29 2 *', 'UTC'), new Date('2026-03-01T00:00:00Z'))?.toISOString(),
		).toBe('2028-02-29T00:00:00.000Z')
		expect(
			nextFireTime(cron('0 0 31 * *', 'UTC'), new Date('2026-09-01T00:00:00Z'))?.toISOString(),
		).toBe('2026-10-31T00:00:00.000Z')
	})

	it('an impossible expression never fires and is refused at parse', () => {
		expect(nextFireTime(cron('0 0 30 2 *', 'UTC'), new Date('2026-01-01T00:00:00Z'))).toBeNull()
		expect(() => parseScheduleSpec('0 0 30 2 *', { tz: 'UTC' })).toThrow(ScheduleValidationError)
	})
})

describe('every and at', () => {
	it('every keeps elapsed time across DST', () => {
		const spec: ScheduleSpec = {
			kind: 'every',
			everyMs: 24 * 3_600_000,
			anchorAt: '2026-10-31T13:00:00.000Z',
		}
		const a = nextFireTime(spec, new Date('2026-10-31T13:00:00Z'))
		const b = nextFireTime(spec, a as Date)
		expect(a?.toISOString()).toBe('2026-11-01T13:00:00.000Z')
		expect(b?.toISOString()).toBe('2026-11-02T13:00:00.000Z')
	})

	it('at fires once and never again', () => {
		const spec: ScheduleSpec = { kind: 'at', at: '2026-09-24T09:00:00.000Z' }
		expect(nextFireTime(spec, new Date('2026-09-24T08:00:00Z'))?.toISOString()).toBe(spec.at)
		expect(nextFireTime(spec, new Date('2026-09-24T09:00:00Z'))).toBeNull()
		expect(previousFireTime(spec, new Date('2026-09-25T00:00:00Z'))?.toISOString()).toBe(spec.at)
	})
})

describe('countOccurrences', () => {
	it('counts every minute over seven days without walking them', () => {
		const started = performance.now()
		const count = countOccurrences(
			cron('* * * * *', 'UTC'),
			new Date('2026-09-01T00:00:00Z'),
			new Date('2026-09-08T00:00:00Z'),
		)
		const elapsed = performance.now() - started
		expect(count.count).toBe(10_080)
		expect(count.capped).toBe(false)
		expect(count.latest?.toISOString()).toBe('2026-09-08T00:00:00.000Z')
		expect(count.first?.toISOString()).toBe('2026-09-01T00:01:00.000Z')
		expect(elapsed).toBeLessThan(250)
	})

	it('caps and says so', () => {
		const count = countOccurrences(
			cron('* * * * *', 'UTC'),
			new Date('2026-09-01T00:00:00Z'),
			new Date('2026-09-15T00:00:00Z'),
			10_000,
		)
		expect(count.count).toBe(10_000)
		expect(count.capped).toBe(true)
		expect(count.latest?.toISOString()).toBe('2026-09-15T00:00:00.000Z')
	})

	it('counts every-intervals arithmetically', () => {
		const spec: ScheduleSpec = {
			kind: 'every',
			everyMs: 60_000,
			anchorAt: '2026-09-01T00:00:00.000Z',
		}
		const count = countOccurrences(
			spec,
			new Date('2026-09-01T00:00:00Z'),
			new Date('2026-09-08T00:00:00Z'),
		)
		expect(count.count).toBe(10_080)
		expect(count.capped).toBe(false)
		expect(
			countOccurrences(
				spec,
				new Date('2026-09-01T00:00:00Z'),
				new Date('2026-09-08T00:00:00Z'),
				100,
			).capped,
		).toBe(true)
	})

	it('counts a repeated hour twice for a wildcard expression across fall-back', () => {
		const count = countOccurrences(
			cron('0 * * * *', 'America/New_York'),
			new Date('2026-11-01T03:30:00Z'),
			new Date('2026-11-01T07:30:00Z'),
		)
		expect(count.count).toBe(4)
	})
})
