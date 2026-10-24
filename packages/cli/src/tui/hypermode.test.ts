/**
 * Hypermode is an independent on/off. It names itself without a level, its
 * messages say the effort stays, and the model hears about it in full once,
 * sparsely every ten messages, and once when it ends.
 */

import { describe, expect, it } from 'vitest'

import {
	HYPERMODE_KEYWORD_TEXT,
	HYPERMODE_REMINDER_EVERY,
	HYPERMODE_ROW_LABEL,
	HypermodeReminders,
	hypermodeOffMessage,
	hypermodeOnMessage,
} from './hypermode.js'

describe('what the operator reads', () => {
	it('names the picker row without a level', () => {
		expect(HYPERMODE_ROW_LABEL).toBe('hypermode (workflows)')
	})

	it('says the effort stays, and mentions workflows', () => {
		expect(hypermodeOnMessage('high')).toBe(
			'Hypermode is on for this conversation: Namzu will use workflows for substantial tasks. Effort stays high.',
		)
		expect(hypermodeOnMessage(undefined)).toContain('Effort stays at the model default.')
		expect(hypermodeOffMessage('low')).toBe(
			'Hypermode is off: workflows are offered only when you ask for one. Effort stays low.',
		)
	})
})

describe('what the model is told about the standing mode', () => {
	it('says it in full the first time, then stays quiet', () => {
		const reminders = new HypermodeReminders()
		expect(reminders.next(true, true)).toContain(
			'Use the `workflow` tool on every substantive task',
		)
		expect(reminders.next(true, true)).toBeUndefined()
	})

	it('repeats it sparsely every ten messages', () => {
		const reminders = new HypermodeReminders()
		reminders.next(true, true)
		const spoken: number[] = []
		for (let message = 1; message <= HYPERMODE_REMINDER_EVERY * 2; message++)
			if (reminders.next(true, true) !== undefined) spoken.push(message)
		expect(spoken).toEqual([HYPERMODE_REMINDER_EVERY, HYPERMODE_REMINDER_EVERY * 2])
	})

	it('says once that it ended, and nothing before it was ever on', () => {
		const reminders = new HypermodeReminders()
		expect(reminders.next(false, true)).toBeUndefined()
		reminders.next(true, true)
		expect(reminders.next(false, true)).toContain('Hypermode is off')
		expect(reminders.next(false, true)).toBeUndefined()
	})

	it('says the full text again when the mode is turned back on', () => {
		const reminders = new HypermodeReminders()
		reminders.next(true, true)
		reminders.next(false, true)
		expect(reminders.next(true, true)).toContain('Hypermode is on')
	})

	it('points a run that cannot start a workflow at the Agent tool instead', () => {
		const reminders = new HypermodeReminders()
		const text = reminders.next(true, false) ?? ''
		expect(text).toContain('not available in this run')
		expect(text).toContain('`Agent`')
	})

	it('words the one-turn keyword as for this turn only', () => {
		expect(HYPERMODE_KEYWORD_TEXT).toContain('use the `workflow` tool')
		expect(HYPERMODE_KEYWORD_TEXT).toContain('this turn only')
	})
})
