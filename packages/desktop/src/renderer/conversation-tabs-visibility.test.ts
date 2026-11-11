import { expect, it } from 'vitest'
import {
	SHOW_TABS_HINT_KEY,
	readShowTabsHint,
	tabsReplacedOnOpen,
	writeShowTabsHint,
} from './conversation-tabs-visibility.js'

const memory = () => {
	const values = new Map<string, string>()
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
	}
}

it('remembers the last answer and reads a missing or broken store as off', () => {
	const storage = memory()
	expect(readShowTabsHint(storage)).toBe(false)
	writeShowTabsHint(storage, true)
	expect(storage.getItem(SHOW_TABS_HINT_KEY)).toBe('1')
	expect(readShowTabsHint(storage)).toBe(true)
	writeShowTabsHint(storage, false)
	expect(readShowTabsHint(storage)).toBe(false)
	const broken = {
		getItem: () => {
			throw new Error('blocked')
		},
		setItem: () => {
			throw new Error('blocked')
		},
	}
	expect(readShowTabsHint(broken)).toBe(false)
	expect(() => writeShowTabsHint(broken, true)).not.toThrow()
})

it('replaces the other ordinary conversations when one is opened, and nothing else', () => {
	const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'p', palId: 'pal-1' }]
	// 'term-1' is a terminal and 'late' is not in the catalogue yet: both stay.
	expect(tabsReplacedOnOpen({ id: 'c' }, ['a', 'b', 'c', 'p', 'term-1', 'late'], rows)).toEqual([
		'a',
		'b',
	])
	expect(tabsReplacedOnOpen({ id: 'p', palId: 'pal-1' }, ['a', 'p'], rows)).toEqual([])
	expect(tabsReplacedOnOpen({ id: 'a' }, ['a'], rows)).toEqual([])
})
