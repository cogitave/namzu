import { expect, it } from 'vitest'
import { ConversationUnread } from './conversation-unread.js'
import { viewedTabs } from './viewed-conversations.js'

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

it('refuses an id that would make the saved file unreadable, and a flood of them', () => {
	const unread = new ConversationUnread([], 2)
	expect(() => unread.set('', true)).toThrow('Invalid conversation')
	expect(() => unread.set('a\u0000b', true)).toThrow('Invalid conversation')
	expect(() => unread.set('x'.repeat(401), true)).toThrow('Invalid conversation')
	unread.set('a', true)
	unread.set('b', true)
	expect(() => unread.set('c', true)).toThrow('Too many')
	expect(new ConversationUnread(['a', '', 'b', 'c'], 2).ids()).toEqual(['a', 'b'])
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
