import { expect, it } from 'vitest'
import {
	SHOW_TABS_HINT_KEY,
	blankConversationTabs,
	readShowTabsHint,
	tabsReplacedOnOpen,
	visibleChordTabs,
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

it('steps through the conversation behind a terminal and through kept blank tabs', () => {
	const rows = [
		{ id: 'a', title: 'alpha chat' },
		{ id: 'b', title: 'New conversation' },
		{ id: 'c', title: 'other chat' },
		{ id: 'p', title: 'New conversation', palId: 'pal-1' },
	]
	const terminals = new Set(['t1', 't2'])
	// A terminal in front: the conversation behind it is still in the ring.
	expect(
		visibleChordTabs({
			tabs: ['a', 't1', 't2'],
			front: 't2',
			behind: 'a',
			terminals,
			conversations: rows,
		}),
	).toEqual(['a', 't1', 't2'])
	// A kept blank tab is reachable; a tab with a sidebar row, and a Pal's, are not.
	expect(
		visibleChordTabs({
			tabs: ['a', 'b', 'c', 'p'],
			front: 'a',
			behind: 'a',
			terminals,
			conversations: rows,
		}),
	).toEqual(['a', 'b'])
	expect(blankConversationTabs(['a', 'b', 'p', 'late'], rows)).toEqual(['b'])
})
