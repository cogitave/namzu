import { describe, expect, it } from 'vitest'
import { describeSchedule } from '../describe.js'
import { ScheduleValidationError } from '../errors.js'
import { parseDuration, parseScheduleSpec, upcomingFireTimes } from '../spec.js'
import { validateTimeZone } from '../tz.js'

const now = new Date('2026-09-23T10:00:30Z')

describe('parseScheduleSpec', () => {
	it('reads in, at and ISO instants', () => {
		expect(parseScheduleSpec('in 30m', { now, tz: 'UTC' })).toEqual({
			kind: 'at',
			at: '2026-09-23T10:30:30.000Z',
		})
		expect(parseScheduleSpec('at 2026-09-24 09:00', { now, tz: 'Europe/Istanbul' })).toEqual({
			kind: 'at',
			at: '2026-09-24T06:00:00.000Z',
		})
		expect(parseScheduleSpec('at 2026-09-24T09:00', { now, tz: 'UTC' })).toEqual({
			kind: 'at',
			at: '2026-09-24T09:00:00.000Z',
		})
		expect(parseScheduleSpec('2026-09-24T09:00:00+02:00', { now, tz: 'UTC' })).toEqual({
			kind: 'at',
			at: '2026-09-24T07:00:00.000Z',
		})
		// 09:00 already passed today in UTC → tomorrow.
		expect(parseScheduleSpec('at 09:00', { now, tz: 'UTC' })).toEqual({
			kind: 'at',
			at: '2026-09-24T09:00:00.000Z',
		})
	})

	it('refuses a past instant and a time the clocks skip', () => {
		expect(() => parseScheduleSpec('at 2020-01-01 00:00', { now, tz: 'UTC' })).toThrow(/past/)
		expect(() => parseScheduleSpec('at 2027-03-14 02:30', { now, tz: 'America/New_York' })).toThrow(
			/does not exist/,
		)
	})

	it('reads every, anchored to the minute, and refuses what it would have to round', () => {
		expect(parseScheduleSpec('every 90m', { now, tz: 'UTC' })).toEqual({
			kind: 'every',
			everyMs: 90 * 60_000,
			anchorAt: '2026-09-23T10:00:00.000Z',
		})
		expect(() => parseScheduleSpec('every 30s', { now })).toThrow(/every 1m/)
		expect(() => parseScheduleSpec('every 90s', { now })).toThrow(/every 1m and every 2m/)
	})

	it('reads cron and macros in the given zone', () => {
		expect(parseScheduleSpec('0 9 * * 1-5', { now, tz: 'Europe/Istanbul' })).toEqual({
			kind: 'cron',
			expr: '0 9 * * 1-5',
			tz: 'Europe/Istanbul',
		})
		expect(parseScheduleSpec('@daily', { now, tz: 'UTC' })).toEqual({
			kind: 'cron',
			expr: '0 0 * * *',
			tz: 'UTC',
		})
		expect(() => parseScheduleSpec('@reboot', { now })).toThrow(ScheduleValidationError)
	})

	it('refuses unknown zones and durations', () => {
		expect(() => validateTimeZone('Mars/Olympus')).toThrow(/unknown time zone/)
		expect(() => parseDuration('soon')).toThrow(/not a duration/)
		expect(() => parseScheduleSpec('', { now })).toThrow(/required/)
	})
})

describe('describeSchedule and upcoming times', () => {
	it('puts common shapes in words', () => {
		expect(describeSchedule({ kind: 'cron', expr: '0 3 * * *', tz: 'Europe/Istanbul' })).toBe(
			'at 03:00 every day (Europe/Istanbul)',
		)
		expect(describeSchedule({ kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' })).toBe(
			'at 09:00 on Monday through Friday (UTC)',
		)
		expect(describeSchedule({ kind: 'cron', expr: '*/15 * * * *', tz: 'UTC' })).toBe(
			'every 15 minutes every day (UTC)',
		)
		expect(describeSchedule({ kind: 'cron', expr: '0 * * * *', tz: 'UTC' })).toBe(
			'every hour, on the hour every day (UTC)',
		)
		expect(
			describeSchedule({ kind: 'every', everyMs: 1_800_000, anchorAt: now.toISOString() }),
		).toBe('every 30 minutes')
		expect(
			describeSchedule({ kind: 'at', at: '2026-09-24T06:00:00.000Z' }, { tz: 'Europe/Istanbul' }),
		).toBe('once at 2026-09-24 09:00 (Europe/Istanbul)')
	})

	it('lists the next three fire times', () => {
		const times = upcomingFireTimes({ kind: 'cron', expr: '0 3 * * *', tz: 'UTC' }, now)
		expect(times.map((t) => t.toISOString())).toEqual([
			'2026-09-24T03:00:00.000Z',
			'2026-09-25T03:00:00.000Z',
			'2026-09-26T03:00:00.000Z',
		])
	})
})
