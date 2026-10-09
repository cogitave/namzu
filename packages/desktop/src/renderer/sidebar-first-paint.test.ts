import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { PalSidebarSection } from './pals-page.js'
import { Sidebar } from './sidebar.js'

const sidebar = (projectsLoaded: boolean) =>
	renderToStaticMarkup(
		createElement(Sidebar, {
			projects: [],
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
			projectsLoaded,
		}),
	)

it('shows a quiet placeholder, not the empty-state hint, until the projects have loaded', () => {
	const loading = sidebar(false)
	expect(loading).toContain('sidebar-skeleton')
	expect(loading).not.toContain('Use + to add a project.')
	const loaded = sidebar(true)
	expect(loaded).toContain('Use + to add a project.')
	expect(loaded).not.toContain('sidebar-skeleton')
})

it('never writes "Loading…" next to an empty-state sentence in the Pals list', () => {
	const markup = renderToStaticMarkup(
		createElement(PalSidebarSection, {
			pals: [],
			unreadIds: new Set<string>(),
			creating: false,
			loading: true,
			onCreate: () => {},
			onOpen: () => {},
		}),
	)
	expect(markup).toContain('sidebar-section-skeleton')
	expect(markup).not.toContain('Loading…')
	expect(markup).not.toContain('Create your first Pal')
})
