import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { ConversationTabs } from './conversation-tabs.js'
import { newTabMenuGroups, terminalUnavailableReason } from './new-tab-menu.js'

const ids = (groups: ReturnType<typeof newTabMenuGroups>) => groups.map((g) => g.map((e) => e.id))

it('offers the conversation and terminal, the four splits, then a new window, in that order', () => {
	const groups = newTabMenuGroups({})
	expect(ids(groups)).toEqual([
		['conversation', 'terminal'],
		['conversation-right', 'conversation-below', 'terminal-right', 'terminal-below'],
		['window'],
	])
	expect(groups.flat().map((e) => e.label)).toEqual([
		'New conversation',
		'New terminal',
		'New conversation to the right',
		'New conversation below',
		'New terminal to the right',
		'New terminal below',
		'New window',
	])
	expect(groups.flat().every((e) => e.reason === undefined)).toBe(true)
})

it('disables every terminal entry, and only those, with the reason', () => {
	const flat = newTabMenuGroups({ terminalReason: 'Trust this project to open a terminal.' }).flat()
	expect(flat.filter((e) => e.reason).map((e) => e.id)).toEqual([
		'terminal',
		'terminal-right',
		'terminal-below',
	])
})

it('names why a terminal cannot open', () => {
	const ready = { trusted: true, status: 'ready' }
	expect(terminalUnavailableReason({ bridge: true, project: ready })).toBeUndefined()
	expect(terminalUnavailableReason({ bridge: false, project: ready })).toMatch(/not available/)
	expect(terminalUnavailableReason({ bridge: true, project: undefined })).toMatch(/Open a project/)
	expect(
		terminalUnavailableReason({ bridge: true, project: { ...ready, trusted: false } }),
	).toMatch(/Trust this project/)
	expect(terminalUnavailableReason({ bridge: true, project: { ...ready, palId: 'p' } })).toMatch(
		/Pal/,
	)
	expect(terminalUnavailableReason({ bridge: true, project: { ...ready, status: 'x' } })).toMatch(
		/not ready/,
	)
})

it('keeps the + button named and clickable with or without a menu', () => {
	const base = {
		windowId: 'w',
		groupId: 'g',
		onDetach: vi.fn(),
		tabs: [],
		active: '',
		busy: false,
		running: () => false,
		onSelect: vi.fn(),
		onClose: vi.fn(),
		onNew: vi.fn(),
	}
	const plain = renderToStaticMarkup(createElement(ConversationTabs, base))
	const menu = renderToStaticMarkup(
		createElement(ConversationTabs, { ...base, newMenu: { onAction: vi.fn() } }),
	)
	expect(plain).toContain('aria-label="New conversation tab"')
	expect(menu).toContain('aria-label="New conversation tab"')
})
