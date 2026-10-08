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

it('gives every project row a labelled remove button that is a real button', () => {
	const markup = sidebar(true)
	expect(markup).toContain('aria-label="Remove App"')
	expect(markup).toContain('aria-label="Remove Docs"')
	expect(markup.match(/sidebar-project-remove/g)).toHaveLength(2)
	expect(markup.match(/data-removable="true"/g)).toHaveLength(2)
})

it('offers neither the button nor the menu when the host cannot remove a project', () => {
	const markup = sidebar(false)
	expect(markup).not.toContain('sidebar-project-remove')
	expect(markup).not.toContain('data-removable')
	expect(markup).toContain('aria-label="Open App"')
})
