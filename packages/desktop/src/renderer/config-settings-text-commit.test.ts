import { describe, expect, it } from 'vitest'
import { textCommitAction } from './config-settings-model.js'

describe('leaving a text setting', () => {
	it('does nothing when nothing was typed', () => {
		expect(textCommitAction(undefined, 'namzu')).toBe('nothing')
	})
	it('drops the draft, and the refusal with it, when the text is back to what is saved', () => {
		expect(textCommitAction('namzu', 'namzu')).toBe('discard')
		expect(textCommitAction('', '')).toBe('discard')
	})
	it('saves anything else, including a cleared box', () => {
		expect(textCommitAction('team-x', 'namzu')).toBe('save')
		expect(textCommitAction('', 'namzu')).toBe('save')
	})
})
