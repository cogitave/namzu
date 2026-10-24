/**
 * Hypermode is an independent on/off. It names itself without a level, its
 * messages say the effort stays.
 */

import { describe, expect, it } from 'vitest'

import {
	HYPERMODE_KEYWORD_TEXT,
	HYPERMODE_ROW_LABEL,
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
		expect(hypermodeOnMessage(undefined, false)).toBe(
			'Hypermode is on for this conversation: Namzu will use workflows for substantial tasks.',
		)
		expect(hypermodeOffMessage(undefined, false)).toBe(
			'Hypermode is off: workflows are offered only when you ask for one.',
		)
		expect(hypermodeOffMessage('low')).toBe(
			'Hypermode is off: workflows are offered only when you ask for one. Effort stays low.',
		)
	})
})

describe('the one-turn keyword', () => {
	it('words the one-turn keyword as for this turn only', () => {
		expect(HYPERMODE_KEYWORD_TEXT).toContain('use the `workflow` tool')
		expect(HYPERMODE_KEYWORD_TEXT).toContain('this turn only')
	})
})
