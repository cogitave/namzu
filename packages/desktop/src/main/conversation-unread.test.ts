import { expect, it } from 'vitest'
import { ConversationUnread } from './conversation-unread.js'
import { viewedTabs, windowsHoldingTab } from './viewed-conversations.js'

const none: ReadonlySet<string> = new Set()

it('marks a finished turn unread unless a window is showing that conversation', () => {
	const unread = new ConversationUnread()
	expect(unread.turnEnded('a', new Set(['a']))).toBe(false)
	expect(unread.ids()).toEqual([])
	expect(unread.sequence).toBe(0)
	expect(unread.turnEnded('a', new Set(['b']))).toBe(true)
	expect(unread.ids()).toEqual(['a'])
	expect(unread.sequence).toBe(1)
})

it('does not count a marker that is already there as a change', () => {
	const unread = new ConversationUnread(['a'])
	expect(unread.turnEnded('a', none)).toBe(false)
	expect(unread.set('a', true)).toBe(false)
	expect(unread.sequence).toBe(0)
})

it('clears a marker once, however many windows show the conversation', () => {
	const unread = new ConversationUnread(['a', 'b'])
	// Two windows showing the same tab appear once in the set a caller builds.
	expect(unread.reconcile(new Set(['a']))).toEqual(['a'])
	expect(unread.reconcile(new Set(['a']))).toEqual([])
	expect(unread.ids()).toEqual(['b'])
	expect(unread.sequence).toBe(1)
})

it('numbers every change so a late answer can be told from a newer one', () => {
	const unread = new ConversationUnread()
	unread.set('a', true)
	unread.set('b', true)
	unread.set('a', false)
	expect(unread.sequence).toBe(3)
	expect(unread.set('a', false)).toBe(false)
	expect(unread.sequence).toBe(3)
})

it('refuses an id that would make the saved file unreadable', () => {
	const unread = new ConversationUnread([], 2)
	expect(() => unread.set('', true)).toThrow('Invalid conversation')
	expect(() => unread.set('a\u0000b', true)).toThrow('Invalid conversation')
	expect(() => unread.set('x'.repeat(401), true)).toThrow('Invalid conversation')
	expect(new ConversationUnread(['a', '', 'b', 'c'], 2).ids()).toEqual(['a', 'b'])
})

it('drops the oldest marker instead of failing when the set is full', () => {
	const unread = new ConversationUnread([], 2)
	expect(unread.set('a', true)).toBe(true)
	expect(unread.set('b', true)).toBe(true)
	expect(() => unread.set('c', true)).not.toThrow()
	expect(unread.ids()).toEqual(['b', 'c'])
	expect(unread.sequence).toBe(3)
	const full = new ConversationUnread(Array.from({ length: 1024 }, (_, i) => `id${i}`))
	expect(full.turnEnded('late', none)).toBe(true)
	expect(full.ids()).toHaveLength(1024)
	expect(full.has('id0')).toBe(false)
	expect(full.has('late')).toBe(true)
})

it('forgets conversations that are gone', () => {
	const unread = new ConversationUnread(['a', 'b'])
	expect(unread.forget(['a', 'zzz'])).toBe(true)
	expect(unread.forget(['zzz'])).toBe(false)
	expect(unread.ids()).toEqual(['b'])
})

const layout = {
	version: 1 as const,
	revision: 1,
	windows: [
		{
			id: 'w1',
			focusedGroupId: 'g1',
			root: {
				kind: 'split' as const,
				id: 's',
				direction: 'horizontal' as const,
				ratio: 0.5,
				first: { kind: 'group' as const, id: 'g1', tabs: ['a', 'b'], activeTabId: 'b' },
				second: { kind: 'group' as const, id: 'g2', tabs: ['c'], activeTabId: 'c' },
			},
		},
		{
			id: 'w2',
			focusedGroupId: 'g3',
			root: { kind: 'group' as const, id: 'g3', tabs: ['d', 'e'], activeTabId: 'e' },
		},
		{ id: 'w3', focusedGroupId: null, root: null },
	],
}

it('counts the active tab of every pane of every shown window, and nothing else', () => {
	expect([...viewedTabs(layout, () => true)].sort()).toEqual(['b', 'c', 'e'])
	expect([...viewedTabs(layout, (id) => id === 'w2')]).toEqual(['e'])
	expect([...viewedTabs(layout, () => false)]).toEqual([])
})

it('lists the windows that hold a tab, the one showing it first', () => {
	// `a` is a background tab in w1; `e` is the active tab in w2; `zzz` is nowhere.
	expect(windowsHoldingTab(layout, 'a')).toEqual(['w1'])
	expect(windowsHoldingTab(layout, 'e')).toEqual(['w2'])
	expect(windowsHoldingTab(layout, 'zzz')).toEqual([])
	const both = {
		...layout,
		windows: [
			layout.windows[0] as (typeof layout.windows)[number],
			{
				id: 'w4',
				focusedGroupId: 'g9',
				root: { kind: 'group' as const, id: 'g9', tabs: ['a'], activeTabId: 'a' },
			},
		],
	}
	expect(windowsHoldingTab(both, 'a')).toEqual(['w4', 'w1'])
})
