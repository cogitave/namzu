import { expect, it } from 'vitest'
import { computerWorkspaceIds } from './computer-workspace-toolbar.js'

it('preserves the existing tab and panel IDs for standalone Pal workspaces', () => {
	expect(computerWorkspaceIds()).toEqual({
		chatTab: 'pal-chat-tab',
		computerTab: 'computer-tab',
		chatPanel: 'pal-chat-panel',
		computerPanel: 'pal-computer-panel',
	})
})

it('keeps all tab and panel targets distinct across Pal panes and stable on rerender', () => {
	const left = computerWorkspaceIds('window-group-left')
	const right = computerWorkspaceIds('window-group-right')
	expect(new Set([...Object.values(left), ...Object.values(right)]).size).toBe(8)
	expect(computerWorkspaceIds('window-group-left')).toEqual(left)
	expect(new Set(Object.values(left)).size).toBe(4)
})

it('encodes prefixes without whitespace or collisions between literal escapes and separators', () => {
	const slash = computerWorkspaceIds('window/group Happy')
	const literal = computerWorkspaceIds('window%2Fgroup Happy')
	expect(slash.chatTab).toBe('pal-chat-tab-window%2Fgroup%20Happy')
	expect(slash.chatTab).not.toBe(literal.chatTab)
	for (const id of Object.values(slash)) expect(id).not.toMatch(/\s/)
	expect(computerWorkspaceIds('').chatTab).not.toBe(computerWorkspaceIds().chatTab)
})
