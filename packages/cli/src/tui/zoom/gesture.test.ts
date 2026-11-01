import { describe, expect, it } from 'vitest'

import { ARM_MS, COOLDOWN_MS, EDITED_MS, LeftGesture, REPEAT_MS } from './gesture.js'

const plain = { empty: true, attachments: false } as const

function rig() {
	const clock = { now: 10_000 }
	const gesture = new LeftGesture(() => clock.now)
	return { clock, gesture }
}

describe('the left-arrow gesture', () => {
	it('fires on a single press when the composer is empty', () => {
		const { gesture } = rig()
		expect(gesture.press(plain)).toBe('fire')
	})

	it('leaves the key to the cursor when there is text, an attachment or a modifier', () => {
		const { gesture } = rig()
		expect(gesture.press({ empty: false, attachments: false })).toBe('pass')
		expect(gesture.press({ empty: true, attachments: true })).toBe('pass')
		expect(gesture.press({ ...plain, shift: true })).toBe('pass')
		expect(gesture.press({ ...plain, ctrl: true })).toBe('pass')
		expect(gesture.press({ ...plain, meta: true })).toBe('pass')
		// None of those counted as a press: the next plain one still fires.
		expect(gesture.press(plain)).toBe('fire')
	})

	it('only arms when the composer was emptied by editing a moment ago, and a second press fires', () => {
		const { clock, gesture } = rig()
		gesture.noteEmptied()
		clock.now += 500
		expect(gesture.press(plain)).toBe('arm')
		// Inside the cooldown after an arm, presses are swallowed.
		clock.now += COOLDOWN_MS - 1
		expect(gesture.press(plain)).toBe('swallow')
		clock.now += COOLDOWN_MS + 1
		expect(gesture.press(plain)).toBe('fire')
	})

	it('does not arm when the edit is older than the window', () => {
		const { clock, gesture } = rig()
		gesture.noteEmptied()
		clock.now += EDITED_MS
		expect(gesture.press(plain)).toBe('fire')
	})

	it('drops the arm after its window, and arms again only while the edit is recent', () => {
		const { clock, gesture } = rig()
		gesture.noteEmptied()
		clock.now += 100
		expect(gesture.press(plain)).toBe('arm')
		clock.now += ARM_MS + 1
		// The edit is long past, so this one fires instead of arming a second time.
		expect(gesture.press(plain)).toBe('fire')
	})

	it('typing again forgets that the composer was just emptied', () => {
		const { clock, gesture } = rig()
		gesture.noteEmptied()
		gesture.noteFilled()
		clock.now += 100
		expect(gesture.press(plain)).toBe('fire')
	})

	it('swallows presses closer than the key-repeat interval, however long they go on', () => {
		const { clock, gesture } = rig()
		expect(gesture.press({ ...plain, empty: false })).toBe('pass')
		// A held key: each press follows the last by less than the repeat interval.
		gesture.noteEmptied()
		clock.now += EDITED_MS
		const verdicts: string[] = []
		for (let i = 0; i < 5; i++) {
			verdicts.push(gesture.press(plain))
			clock.now += REPEAT_MS - 1
		}
		expect(verdicts).toEqual(['fire', 'swallow', 'swallow', 'swallow', 'swallow'])
	})

	it('swallows presses within a second of a fire, then fires again', () => {
		const { clock, gesture } = rig()
		expect(gesture.press(plain)).toBe('fire')
		clock.now += REPEAT_MS + 1
		expect(gesture.press(plain)).toBe('swallow')
		clock.now += COOLDOWN_MS
		expect(gesture.press(plain)).toBe('fire')
	})
})
