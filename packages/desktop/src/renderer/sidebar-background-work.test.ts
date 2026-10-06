import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { Sidebar } from './sidebar.js'

const conversations = Array.from({ length: 12 }, (_, index) => ({
	id: `session-${index}`,
	projectId: 'project',
	title: `Conversation ${index}`,
	updatedAt: new Date(12_000 - index * 1_000).toISOString(),
}))

function render(backgroundWork = {}) {
	return renderToStaticMarkup(
		createElement(Sidebar, {
			projects: [
				{ id: 'project', name: 'Project', path: '/fixture', trusted: true, status: 'ready' },
			],
			conversations,
			projectId: 'project',
			sessionId: '',
			conversationCollection: 'recents',
			threads: {},
			backgroundWork,
			open: false,
			opening: false,
			onClose: vi.fn(),
			onSearch: vi.fn(),
			collapsed: false,
			onOpenProject: vi.fn(),
			onNewConversation: vi.fn(),
			onProject: vi.fn(),
			onConversation: vi.fn(),
		}),
	)
}

it('keeps a verified background session visible beyond both collapsed row limits', () => {
	const status = {
		state: 'known' as const,
		runningCount: 1,
		needsAttention: false,
		checkedAt: Date.now(),
		expiresAt: Date.now() + 10_000,
	}
	expect(render()).not.toContain('data-session-id="session-11"')
	expect(render({ 'session-11': status })).toContain('data-session-id="session-11"')
	expect(render({ 'session-11': { ...status, expiresAt: Date.now() - 1 } })).not.toContain(
		'data-session-id="session-11"',
	)
})
