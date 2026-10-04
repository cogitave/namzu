import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { ConversationView } from '../shared/protocol.js'
import { computerWorkspaceIds } from './computer-workspace-toolbar.js'
import {
	type ConversationPalWorkspace,
	ConversationTabs,
	resolveConversationTabSelection,
} from './conversation-tabs.js'

const tabs: ConversationView[] = [
	{ id: 'ordinary', projectId: 'project', title: 'Refine navigation', updatedAt: '' },
	{ id: 'pal-session', projectId: 'pal-project', title: 'selam', updatedAt: '', palId: 'kiro' },
]
const pal: ConversationPalWorkspace = {
	conversationId: 'pal-session',
	idPrefix: 'window-pane',
	palName: 'Kiro',
	activeTab: 'chat',
	computerTabOpen: true,
	profileOpen: true,
	onOpenChat: vi.fn(),
	onOpenComputer: vi.fn(),
	onCloseComputer: vi.fn(),
	onToggleProfile: vi.fn(),
	onToggleChat: vi.fn(),
	onToggleFloating: vi.fn(),
}

function render(workspace = pal, busy = false) {
	return renderToStaticMarkup(
		createElement(ConversationTabs, {
			tabs,
			windowId: 'window',
			groupId: 'pane',
			active: 'pal-session',
			busy,
			running: () => false,
			palNames: { kiro: 'Kiro' },
			palWorkspace: workspace,
			onSelect: vi.fn(),
			onClose: vi.fn(),
			onNew: vi.fn(),
			onDetach: vi.fn(),
		}),
	)
}

it('puts ordinary conversation, Pal chat and computer in one tab list without duplicating the Pal', () => {
	const html = render()
	expect(html.match(/role="tablist"/g)).toHaveLength(1)
	expect(html.match(/role="tab"/g)).toHaveLength(3)
	expect(html.match(/aria-label="Kiro"/g)).toHaveLength(1)
	expect(html).toContain('aria-label="Namzu: Refine navigation"')
	expect(html).toContain('aria-label="Kiro’s computer"')
	expect(html).not.toContain('Namzu: selam')
	expect(html).toContain('data-tab-id="pal-session"')
	expect(html).toContain('aria-label="Close tab Kiro"')
	expect(html).toContain('aria-label="Hide Kiro profile"')
	expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
})

it('links chat and computer to the same pane panels when the computer view is selected', () => {
	const ids = computerWorkspaceIds(pal.idPrefix)
	const html = render({ ...pal, activeTab: 'computer' })
	expect(html).toContain(`id="${ids.chatTab}"`)
	expect(html).toContain(`aria-controls="${ids.chatPanel}"`)
	expect(html).toContain(`id="${ids.computerTab}"`)
	expect(html).toContain(`aria-controls="${ids.computerPanel}"`)
	expect(html.match(/role="tablist"/g)).toHaveLength(1)
	expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
	expect(html.match(/<button[^>]*aria-label="Kiro"[^>]*>/)?.[0]).toContain('aria-selected="false"')
	expect(html.match(/<button[^>]*aria-label="Kiro’s computer"[^>]*>/)?.[0]).toContain(
		'aria-selected="true"',
	)
})

it('routes Pal view switches without changing the conversation or its draft owner', () => {
	const ids = computerWorkspaceIds(pal.idPrefix)
	expect(resolveConversationTabSelection(tabs, 'pal-session', ids.computerTab, pal)).toEqual({
		kind: 'computer',
	})
	expect(resolveConversationTabSelection(tabs, 'pal-session', 'pal-session', pal)).toEqual({
		kind: 'chat',
	})
	expect(resolveConversationTabSelection(tabs, 'pal-session', 'ordinary', pal)).toEqual({
		kind: 'conversation',
		view: tabs[0],
	})
	expect(resolveConversationTabSelection(tabs, 'ordinary', 'pal-session', pal)).toEqual({
		kind: 'conversation',
		view: tabs[1],
	})
	expect(resolveConversationTabSelection(tabs, 'ordinary', ids.computerTab, pal)).toBeNull()
	expect(
		resolveConversationTabSelection(tabs, 'pal-session', ids.computerTab, {
			...pal,
			computerTabOpen: false,
		}),
	).toBeNull()
})

it('freezes conversation and computer selection and closing while their owner transfers', () => {
	const html = render(pal, true)
	for (const label of ['Kiro', 'Kiro’s computer', 'Close tab Kiro', 'Close computer tab']) {
		const button = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0]
		expect(button).toMatch(/\bdisabled=/)
	}
	const owner = html.match(/<div[^>]*data-tab-id="pal-session"[^>]*>/)?.[0]
	expect(owner).toContain('draggable="false"')
})
