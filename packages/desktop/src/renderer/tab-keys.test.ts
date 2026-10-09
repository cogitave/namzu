import { describe, expect, it } from 'vitest'
import { type TabKeyEvent, movedTabIndex, selectedTabIndex, tabChord } from './tab-keys.js'

const press = (code: string, over: Partial<TabKeyEvent> = {}): TabKeyEvent => ({
	key: code,
	code,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	altKey: false,
	...over,
})
const linux = { mac: false }

describe('tabChord', () => {
	it('closes with Ctrl+W, or Ctrl+F4 anywhere', () => {
		expect(tabChord(press('KeyW', { ctrlKey: true }), linux)).toEqual({ kind: 'close' })
		expect(tabChord(press('F4', { ctrlKey: true }), linux)).toEqual({ kind: 'close' })
	})
	it('leaves Ctrl+W to the shell inside a terminal', () => {
		expect(tabChord(press('KeyW', { ctrlKey: true }), { mac: false, inTerminal: true })).toBe(
			undefined,
		)
		expect(tabChord(press('F4', { ctrlKey: true }), { mac: false, inTerminal: true })).toEqual({
			kind: 'close',
		})
	})
	it('switches with Ctrl+Tab and Ctrl+PageUp/PageDown', () => {
		expect(tabChord(press('Tab', { ctrlKey: true }), linux)).toEqual({ kind: 'next' })
		expect(tabChord(press('Tab', { ctrlKey: true, shiftKey: true }), linux)).toEqual({
			kind: 'previous',
		})
		expect(tabChord(press('PageDown', { ctrlKey: true }), linux)).toEqual({ kind: 'next' })
		expect(tabChord(press('PageUp', { ctrlKey: true }), linux)).toEqual({ kind: 'previous' })
	})
	it('reorders with Ctrl+Shift+PageUp/PageDown', () => {
		expect(tabChord(press('PageUp', { ctrlKey: true, shiftKey: true }), linux)).toEqual({
			kind: 'move',
			delta: -1,
		})
		expect(tabChord(press('PageDown', { ctrlKey: true, shiftKey: true }), linux)).toEqual({
			kind: 'move',
			delta: 1,
		})
	})
	it('picks a numbered tab with Ctrl+1 to Ctrl+9', () => {
		expect(tabChord(press('Digit1', { ctrlKey: true }), linux)).toEqual({
			kind: 'select',
			number: 1,
		})
		expect(tabChord(press('Digit9', { ctrlKey: true }), linux)).toEqual({
			kind: 'select',
			number: 9,
		})
		expect(tabChord(press('Digit0', { ctrlKey: true }), linux)).toBe(undefined)
	})
	it('uses Command on a Mac for close and numbers, Control for Tab', () => {
		const mac = { mac: true }
		expect(tabChord(press('KeyW', { metaKey: true }), mac)).toEqual({ kind: 'close' })
		expect(tabChord(press('KeyW', { ctrlKey: true }), mac)).toBe(undefined)
		expect(tabChord(press('Digit2', { metaKey: true }), mac)).toEqual({ kind: 'select', number: 2 })
		expect(tabChord(press('Tab', { ctrlKey: true }), mac)).toEqual({ kind: 'next' })
	})
	it('ignores Alt chords (AltGr types characters) and plain keys', () => {
		expect(tabChord(press('Digit1', { ctrlKey: true, altKey: true }), linux)).toBe(undefined)
		expect(tabChord(press('Tab'), linux)).toBe(undefined)
	})
	it('splits to the right with Ctrl+Shift+Backslash', () => {
		expect(tabChord(press('Backslash', { ctrlKey: true, shiftKey: true }), linux)).toEqual({
			kind: 'split-right',
		})
	})
})

describe('tab positions', () => {
	it('the ninth number is always the last tab, and a missing number picks nothing', () => {
		expect(selectedTabIndex(1, 3)).toBe(0)
		expect(selectedTabIndex(9, 3)).toBe(2)
		expect(selectedTabIndex(5, 3)).toBeUndefined()
		expect(selectedTabIndex(1, 0)).toBeUndefined()
	})
	it('stops at both ends of the strip', () => {
		expect(movedTabIndex(0, -1, 3)).toBeUndefined()
		expect(movedTabIndex(2, 1, 3)).toBeUndefined()
		expect(movedTabIndex(1, 1, 3)).toBe(2)
	})
})
