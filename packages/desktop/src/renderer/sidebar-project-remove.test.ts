import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { ProjectView } from '../shared/protocol.js'
import { Sidebar } from './sidebar.js'

const project = (over: Partial<ProjectView>): ProjectView => ({
	id: 'p1',
	path: '/work/app',
	name: 'App',
	trusted: true,
	status: 'ready',
	...over,
})

const sidebar = (removable: boolean) =>
	renderToStaticMarkup(
		createElement(Sidebar, {
			projects: [project({}), project({ id: 'p2', name: 'Docs', path: '/work/docs' })],
			conversations: [],
			projectId: '',
			sessionId: '',
			conversationCollection: 'projects',
			threads: {},
			open: false,
			opening: false,
			onClose: () => {},
			onSearch: () => {},
			collapsed: false,
			onOpenProject: () => {},
			onNewConversation: () => {},
			onProject: () => {},
			onConversation: () => {},
			onRemoveProject: removable ? () => {} : undefined,
		}),
	)

it('keeps removal out of reach of a single click: only a labelled menu button leads to it', () => {
	const markup = sidebar(true)
	// No close-style button on the row any more; the "…" button opens a menu that holds the removal.
	expect(markup).not.toContain('sidebar-project-remove')
	expect(markup).not.toContain('aria-label="Remove App"')
	expect(markup).toContain('aria-label="Actions for App"')
	expect(markup).toContain('aria-label="Actions for Docs"')
	expect(markup.match(/sidebar-project-more/g)).toHaveLength(2)
	expect(markup.match(/data-removable="true"/g)).toHaveLength(2)
})

it('offers neither the button nor the menu when the host cannot remove a project', () => {
	const markup = sidebar(false)
	expect(markup).not.toContain('sidebar-project-more')
	expect(markup).not.toContain('data-removable')
	expect(markup).toContain('aria-label="Open App"')
})
