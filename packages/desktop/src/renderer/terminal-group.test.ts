import { describe, expect, it } from 'vitest'
import { terminalTabId } from '../shared/terminal-tabs.js'
import { rememberConversation, splitTerminalGroup } from './terminal-group.js'

const T1 = terminalTabId('0f0e0d0c-0b0a-4908-8706-050403020100')
const T2 = terminalTabId('1f0e0d0c-0b0a-4908-8706-050403020101')
const group = (tabs: string[], activeTabId: string) => ({
	kind: 'group' as const,
	id: 'g',
	tabs,
	activeTabId,
})

describe('splitTerminalGroup', () => {
	it('hands a pane without terminals back unchanged', () => {
		const g = group(['a', 'b'], 'b')
		const split = splitTerminalGroup(g, 'a')
		expect(split.group).toBe(g)
		expect(split.terminalIds).toEqual([])
		expect(split.activeTerminalId).toBeUndefined()
	})

	it('hides terminals from the conversation side and keeps the strip order', () => {
		const split = splitTerminalGroup(group(['a', T1, 'b', T2], 'b'), 'a')
		expect(split.group.tabs).toEqual(['a', 'b'])
		expect(split.group.activeTabId).toBe('b')
		expect(split.order).toEqual(['a', T1, 'b', T2])
		expect(split.terminalIds).toEqual([T1, T2])
		expect(split.activeTerminalId).toBeUndefined()
	})

	it('keeps the conversation that was in front while a terminal is in front', () => {
		const g = group(['a', T1, 'b'], T1)
		expect(splitTerminalGroup(g, 'b')).toMatchObject({
			group: { tabs: ['a', 'b'], activeTabId: 'b' },
			activeTerminalId: T1,
		})
		// A remembered conversation that has gone falls back to the first one, or to none.
		expect(splitTerminalGroup(g, 'gone').group.activeTabId).toBe('a')
		expect(splitTerminalGroup(group([T1], T1), undefined).group).toMatchObject({
			tabs: [],
			activeTabId: '',
		})
	})
})

describe('rememberConversation', () => {
	it('follows the conversation in front and holds it through a terminal', () => {
		expect(rememberConversation(undefined, group(['a', T1], 'a'))).toBe('a')
		expect(rememberConversation('a', group(['a', T1], T1))).toBe('a')
		expect(rememberConversation('gone', group(['a', T1], T1))).toBeUndefined()
		expect(rememberConversation(undefined, group([T1], T1))).toBeUndefined()
	})
})
