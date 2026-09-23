import { describe, expect, it } from 'vitest'
import { parseCronExpression } from '../cron.js'
import { ScheduleValidationError } from '../errors.js'

function refusal(expr: string): ScheduleValidationError {
	try {
		parseCronExpression(expr)
	} catch (error) {
		if (error instanceof ScheduleValidationError) return error
		throw error
	}
	throw new Error(`"${expr}" was accepted`)
}

describe('parseCronExpression', () => {
	it('reads every field form: lists, ranges, steps and names', () => {
		const e = parseCronExpression('0,30 9-17/2 1,15 jan-mar mon-fri')
		expect(e.minutes).toEqual([0, 30])
		expect(e.hours).toEqual([9, 11, 13, 15, 17])
		expect(e.daysOfMonth).toEqual([1, 15])
		expect(e.months).toEqual([1, 2, 3])
		expect(e.daysOfWeek).toEqual([1, 2, 3, 4, 5])
		expect(e.fixedTime).toBe(false)
		expect(e.domRestricted && e.dowRestricted).toBe(true)
	})

	it('treats 7 as Sunday and folds it into 0', () => {
		expect(parseCronExpression('0 0 * * 7').daysOfWeek).toEqual([0])
		expect(parseCronExpression('0 0 * * 5-7').daysOfWeek).toEqual([0, 5, 6])
	})

	it('expands macros', () => {
		expect(parseCronExpression('@hourly').source).toBe('0 * * * *')
		expect(parseCronExpression('@daily').source).toBe('0 0 * * *')
		expect(parseCronExpression('@weekly').source).toBe('0 0 * * 0')
		expect(parseCronExpression('@monthly').source).toBe('0 0 1 * *')
		expect(parseCronExpression('@yearly').source).toBe('0 0 1 1 *')
	})

	it('classifies fixed-time and wildcard expressions for the DST rule', () => {
		expect(parseCronExpression('30 2 * * *').fixedTime).toBe(true)
		expect(parseCronExpression('0 1,13 * * *').fixedTime).toBe(true)
		expect(parseCronExpression('0 * * * *').fixedTime).toBe(false)
		expect(parseCronExpression('*/15 3 * * *').fixedTime).toBe(false)
	})

	it('accepts month and day names that contain L and W', () => {
		expect(parseCronExpression('0 0 * jul wed').months).toEqual([7])
	})

	it.each([
		['0 0 L * *', 'L'],
		['0 0 15W * *', 'W'],
		['0 0 * * 5#2', '#'],
		['0 0 ? * *', '?'],
	])('refuses %s naming %s', (expr, token) => {
		expect(refusal(expr).token).toBe(token)
	})

	it('refuses a seconds field, @reboot, out-of-range values, empty lists and */0', () => {
		expect(refusal('0 0 0 * * *').message).toMatch(/seconds/)
		expect(refusal('@reboot').token).toBe('@reboot')
		expect(refusal('60 * * * *').token).toBe('60')
		expect(refusal('0 24 * * *').token).toBe('24')
		expect(refusal('0 0 0 * *').token).toBe('0')
		expect(refusal('0,,5 * * * *').message).toMatch(/empty list/)
		expect(refusal('*/0 * * * *').message).toMatch(/step/)
		expect(refusal('0 0 * * * extra').message).toMatch(/seconds|five/)
		expect(refusal('5-1 * * * *').message).toMatch(/backwards/)
	})
})
