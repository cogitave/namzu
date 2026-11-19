import { expect, it } from 'vitest'
import { readSessionPanelOpen, writeSessionPanelOpen } from './session-panel-state.js'

it('keeps the panel closed until the person opens it, and survives a blocked store', () => {
	const data = new Map<string, string>()
	const store = {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
	}
	expect(readSessionPanelOpen(store)).toBe(false)
	writeSessionPanelOpen(store, true)
	expect(readSessionPanelOpen(store)).toBe(true)
	writeSessionPanelOpen(store, false)
	expect(readSessionPanelOpen(store)).toBe(false)
	const blocked = {
		getItem: () => {
			throw new Error('blocked')
		},
		setItem: () => {
			throw new Error('blocked')
		},
	}
	expect(readSessionPanelOpen(blocked)).toBe(false)
	expect(() => writeSessionPanelOpen(blocked, true)).not.toThrow()
	expect(readSessionPanelOpen(undefined)).toBe(false)
})
