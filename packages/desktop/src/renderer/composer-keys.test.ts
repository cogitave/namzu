import { describe, expect, it } from 'vitest'
import { type ComposerKeyInput, decideComposerKey, isComposing } from './composer-keys.js'

const input = (overrides: Partial<ComposerKeyInput> = {}): ComposerKeyInput => ({
	key: 'Enter',
	shiftKey: false,
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	composing: false,
	value: '',
	selectionStart: 0,
	selectionEnd: 0,
	hasDraft: false,
	editableQueued: false,
	trayEditing: false,
	hasHistory: false,
	walking: false,
	canHold: false,
	...overrides,
})

describe('Enter', () => {
	it('sends, and Shift+Enter adds a line', () => {
		expect(decideComposerKey(input()).action).toBe('send')
		expect(decideComposerKey(input({ shiftKey: true })).action).toBe('none')
	})

	it('holds the message with Ctrl+Enter or Cmd+Enter while a reply can take it', () => {
		for (const chord of [{ ctrlKey: true }, { metaKey: true }]) {
			expect(decideComposerKey(input({ ...chord, canHold: true })).action).toBe('queue')
		}
	})

	it('sends with the chord when nothing can be held, so the chord never does nothing', () => {
		expect(decideComposerKey(input({ ctrlKey: true, canHold: false })).action).toBe('send')
	})

	it('does not hold on Shift+Ctrl+Enter', () => {
		expect(decideComposerKey(input({ ctrlKey: true, shiftKey: true, canHold: true })).action).toBe(
			'none',
		)
	})
})

describe('input methods', () => {
	it('gives every key to a composing input method, including the legacy key code', () => {
		for (const key of ['Enter', 'ArrowUp', 'ArrowDown', 'Tab']) {
			expect(
				decideComposerKey(
					input({ key, composing: true, hasHistory: true, walking: true, canHold: true }),
				).action,
			).toBe('none')
		}
		expect(isComposing({ isComposing: true })).toBe(true)
		expect(isComposing({ keyCode: 229 })).toBe(true)
		expect(isComposing({ nativeEvent: { isComposing: false, keyCode: 229 } })).toBe(true)
		expect(isComposing({ keyCode: 13, nativeEvent: { isComposing: false, keyCode: 13 } })).toBe(
			false,
		)
	})
})

describe('Tab', () => {
	it('holds the message only when it can be held', () => {
		expect(decideComposerKey(input({ key: 'Tab', canHold: true })).action).toBe('queue')
		expect(decideComposerKey(input({ key: 'Tab' })).action).toBe('none')
		expect(decideComposerKey(input({ key: 'Tab', canHold: true, shiftKey: true })).action).toBe(
			'none',
		)
	})
})

describe('ArrowUp', () => {
	it('takes the newest waiting message back from an empty box before it recalls history', () => {
		expect(
			decideComposerKey(input({ key: 'ArrowUp', editableQueued: true, hasHistory: true })).action,
		).toBe('edit-queued')
	})

	it('recalls history when no message waits, or one is already being edited', () => {
		expect(decideComposerKey(input({ key: 'ArrowUp', hasHistory: true }))).toEqual({
			action: 'recall',
			direction: 'older',
		})
		expect(
			decideComposerKey(
				input({ key: 'ArrowUp', editableQueued: true, trayEditing: true, hasHistory: true }),
			).action,
		).toBe('recall')
	})

	it('does nothing without history, or with a modifier', () => {
		expect(decideComposerKey(input({ key: 'ArrowUp' })).action).toBe('none')
		expect(
			decideComposerKey(input({ key: 'ArrowUp', hasHistory: true, altKey: true })).action,
		).toBe('none')
	})

	it('moves the caret first in a draft the person is typing', () => {
		const typing = input({
			key: 'ArrowUp',
			hasHistory: true,
			hasDraft: true,
			value: 'one\ntwo',
			selectionStart: 7,
			selectionEnd: 7,
		})
		expect(decideComposerKey(typing).action).toBe('none')
		expect(decideComposerKey({ ...typing, selectionStart: 0, selectionEnd: 0 }).action).toBe(
			'recall',
		)
	})
})

describe('ArrowDown', () => {
	it('walks forward only while a recalled message is in the box', () => {
		const down = input({
			key: 'ArrowDown',
			hasHistory: true,
			value: 'old',
			selectionStart: 3,
			selectionEnd: 3,
		})
		expect(decideComposerKey(down).action).toBe('none')
		expect(decideComposerKey({ ...down, walking: true })).toEqual({
			action: 'recall',
			direction: 'newer',
		})
	})

	it('moves through a long wrapped recalled message first, up and down', () => {
		const paragraph = 'word '.repeat(120).trim()
		const walkingIn = input({
			key: 'ArrowUp',
			walking: true,
			hasHistory: true,
			value: paragraph,
			selectionStart: paragraph.length,
			selectionEnd: paragraph.length,
		})
		expect(decideComposerKey(walkingIn).action).toBe('none')
		expect(decideComposerKey({ ...walkingIn, selectionStart: 0, selectionEnd: 0 }).action).toBe(
			'recall',
		)
		const down = { ...walkingIn, key: 'ArrowDown', selectionStart: 100, selectionEnd: 100 }
		expect(decideComposerKey(down).action).toBe('none')
		expect(
			decideComposerKey({
				...down,
				selectionStart: paragraph.length,
				selectionEnd: paragraph.length,
			}).action,
		).toBe('recall')
	})

	it('moves through the lines of a recalled message first', () => {
		const down = input({
			key: 'ArrowDown',
			walking: true,
			value: 'one\ntwo',
			selectionStart: 1,
			selectionEnd: 1,
		})
		expect(decideComposerKey(down).action).toBe('none')
	})
})
