import { describe, expect, it } from 'vitest'

import {
	MESSAGE_GAP_NOTE_MS,
	describeGap,
	messageTimeNote,
	previousSentAt,
} from './message-time.js'

const ISTANBUL = { offsetMinutes: 180, name: 'Europe/Istanbul' }
// 2026-11-16 19:41 UTC, which is 22:41 in Istanbul.
const T0 = Date.UTC(2026, 10, 16, 19, 41)
const min = (n: number) => n * 60_000

describe('the line that says when a message was sent', () => {
	it('names the time and the zone on the first message, and not the date', () => {
		expect(messageTimeNote({ now: T0, zone: ISTANBUL })).toBe(
			'[Sent at 22:41, UTC+03:00 Europe/Istanbul]',
		)
	})

	it('handles a zone behind UTC and one with no name', () => {
		expect(messageTimeNote({ now: T0, zone: { offsetMinutes: -330 } })).toBe(
			'[Sent at 14:11, UTC-05:30]',
		)
	})

	it('adds nothing for a quick follow-up', () => {
		expect(
			messageTimeNote({ now: T0 + MESSAGE_GAP_NOTE_MS - 1, previous: T0, zone: ISTANBUL }),
		).toBeUndefined()
		expect(messageTimeNote({ now: T0 + min(2), previous: T0, zone: ISTANBUL })).toBeUndefined()
	})

	it('states the gap in words once it is at least a few minutes', () => {
		expect(messageTimeNote({ now: T0 + min(135), previous: T0, zone: ISTANBUL })).toBe(
			'[Sent 2 h 15 min after the previous message, at 00:56, UTC+03:00 Europe/Istanbul]',
		)
		expect(
			messageTimeNote({ now: T0 + MESSAGE_GAP_NOTE_MS, previous: T0, zone: ISTANBUL }),
		).toContain('5 min after the previous message')
	})

	it('adds nothing for a clock that went backwards', () => {
		expect(messageTimeNote({ now: T0, previous: T0 + min(60), zone: ISTANBUL })).toBeUndefined()
	})

	it('writes the gap in whole units, largest first', () => {
		expect(describeGap(min(45))).toBe('45 min')
		expect(describeGap(min(60))).toBe('1 h')
		expect(describeGap(min(61))).toBe('1 h 1 min')
		expect(describeGap(min(24 * 60))).toBe('1 d')
		expect(describeGap(min(3 * 24 * 60 + 4 * 60 + 30))).toBe('3 d 4 h')
	})
})

describe('the previous message the gap is measured from', () => {
	it('is the last thing the person typed, not a note the host wrote', () => {
		expect(
			previousSentAt([
				{ role: 'user', timestamp: 100 },
				{ role: 'assistant', timestamp: 200 },
				{ role: 'user', source: { type: 'runtime-context' }, timestamp: 300 },
			]),
		).toBe(100)
		expect(previousSentAt([])).toBeUndefined()
		expect(previousSentAt([{ role: 'assistant', timestamp: 5 }])).toBeUndefined()
	})
})
