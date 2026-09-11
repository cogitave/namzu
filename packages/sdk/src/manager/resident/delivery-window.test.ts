import { describe, expect, it } from 'vitest'
import {
	type ResidentDeliveryWindowConfig,
	createResidentDeliveryWindow,
} from './delivery-window.js'
import type { ResidentOutboxMessage } from './outbox.js'

// The time gate must not depend on the destination or body of a message.
const message = Object.freeze({}) as ResidentOutboxMessage
const day: ResidentDeliveryWindowConfig = {
	timeZone: 'UTC',
	startMinute: 9 * 60,
	endMinute: 17 * 60,
}

function at(value: string): number {
	return Date.parse(value)
}

describe('resident delivery windows', () => {
	it('admits an inclusive start and defers an exclusive end in UTC', () => {
		const gate = createResidentDeliveryWindow(day)
		expect(gate(message, at('2026-09-11T09:00:00.000Z'))).toEqual({ allow: true })
		expect(gate(message, at('2026-09-11T16:59:59.999Z'))).toEqual({ allow: true })
		expect(gate(message, at('2026-09-11T17:00:00.000Z'))).toMatchObject({
			allow: false,
			nextCheckAt: at('2026-09-12T09:00:00.000Z'),
		})
	})

	it('opens at the next minute boundary, including subsecond input', () => {
		const gate = createResidentDeliveryWindow(day)
		expect(gate(message, at('2026-09-11T08:59:59.999Z'))).toMatchObject({
			allow: false,
			nextCheckAt: at('2026-09-11T09:00:00.000Z'),
		})
	})

	it('supports an overnight window and local midnight without hour 24', () => {
		const gate = createResidentDeliveryWindow({ ...day, startMinute: 22 * 60, endMinute: 6 * 60 })
		for (const value of ['22:00:00.000', '23:59:59.999', '00:00:00.000', '05:59:59.999']) {
			expect(gate(message, at(`2026-09-11T${value}Z`))).toEqual({ allow: true })
		}
		expect(gate(message, at('2026-09-11T06:00:00.000Z'))).toMatchObject({
			allow: false,
			nextCheckAt: at('2026-09-11T22:00:00.000Z'),
		})
	})

	it('uses an explicit non-integral-hour IANA offset', () => {
		const gate = createResidentDeliveryWindow({ ...day, timeZone: 'Asia/Kathmandu' })
		expect(gate(message, at('2026-09-11T03:14:59.999Z'))).toMatchObject({
			allow: false,
			nextCheckAt: at('2026-09-11T03:15:00.000Z'),
		})
	})

	it('opens inside a spring-forward window when its starting local minute does not exist', () => {
		const gate = createResidentDeliveryWindow({
			timeZone: 'America/New_York',
			startMinute: 2 * 60 + 30,
			endMinute: 3 * 60 + 30,
		})
		expect(gate(message, at('2026-03-08T06:59:59.999Z'))).toMatchObject({
			allow: false,
			nextCheckAt: at('2026-03-08T07:00:00.000Z'),
		})
		expect(gate(message, at('2026-03-08T07:00:00.000Z'))).toEqual({ allow: true })
	})

	it('skips a wholly nonexistent spring-forward window until the following day', () => {
		const gate = createResidentDeliveryWindow({
			timeZone: 'America/New_York',
			startMinute: 2 * 60 + 15,
			endMinute: 2 * 60 + 45,
		})
		expect(gate(message, at('2026-03-08T06:59:59.999Z'))).toMatchObject({
			allow: false,
			nextCheckAt: at('2026-03-09T06:15:00.000Z'),
		})
	})

	it('allows both occurrences of a folded local window and defers between them', () => {
		const gate = createResidentDeliveryWindow({
			timeZone: 'America/New_York',
			startMinute: 90,
			endMinute: 105,
		})
		expect(gate(message, at('2026-11-01T05:30:00.000Z'))).toEqual({ allow: true })
		expect(gate(message, at('2026-11-01T05:45:00.000Z'))).toMatchObject({
			allow: false,
			nextCheckAt: at('2026-11-01T06:30:00.000Z'),
		})
		expect(gate(message, at('2026-11-01T06:30:00.000Z'))).toEqual({ allow: true })
		expect(gate(message, at('2026-11-01T06:45:00.000Z'))).toMatchObject({
			allow: false,
			nextCheckAt: at('2026-11-02T06:30:00.000Z'),
		})
	})

	it('handles a midnight end as exclusive', () => {
		const gate = createResidentDeliveryWindow({ ...day, startMinute: 23 * 60, endMinute: 0 })
		expect(gate(message, at('2026-09-11T23:59:59.999Z'))).toEqual({ allow: true })
		expect(gate(message, at('2026-09-12T00:00:00.000Z'))).toMatchObject({
			allow: false,
			nextCheckAt: at('2026-09-12T23:00:00.000Z'),
		})
	})

	it('captures the configuration so later mutation cannot alter its boundaries', () => {
		const config = { ...day }
		const gate = createResidentDeliveryWindow(config)
		config.startMinute = 12 * 60
		config.timeZone = 'Asia/Tokyo'
		expect(gate(message, at('2026-09-11T09:00:00.000Z'))).toEqual({ allow: true })
	})

	it.each(['', ' ', ' UTC', 'UTC ', 'Not/A_Time_Zone', '+01:00', '-05:00', undefined])(
		'rejects a missing, unnamed, or invalid time zone: %s',
		(timeZone) => {
			expect(() =>
				createResidentDeliveryWindow({ ...day, timeZone } as ResidentDeliveryWindowConfig),
			).toThrow(TypeError)
		},
	)

	it.each([-1, 1440, 2.5, Number.NaN, Number.POSITIVE_INFINITY, undefined])(
		'rejects invalid start or end minutes: %s',
		(value) => {
			for (const field of ['startMinute', 'endMinute']) {
				expect(() => createResidentDeliveryWindow({ ...day, [field]: value })).toThrow(TypeError)
			}
		},
	)

	it('rejects zero-width windows rather than treating them as all day', () => {
		expect(() => createResidentDeliveryWindow({ ...day, endMinute: day.startMinute })).toThrow(
			TypeError,
		)
	})

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 8.64e15 + 1])(
		'rejects timestamps outside the finite Date range: %s',
		(now) => {
			expect(() => createResidentDeliveryWindow(day)(message, now)).toThrow(TypeError)
		},
	)

	it('stops searching at the Date boundary without returning an invalid next check', () => {
		expect(createResidentDeliveryWindow(day)(message, 8.64e15)).toMatchObject({
			allow: false,
			nextCheckAt: null,
		})
	})
})
