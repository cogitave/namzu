import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { ThreadCard } from './thread-card.js'

const fresh = {
	state: 'known' as const,
	runningCount: 1,
	needsAttention: true,
	checkedAt: Date.now(),
	expiresAt: Date.now() + 10_000,
}

function render(palId?: string, status = fresh) {
	return renderToStaticMarkup(
		createElement(ThreadCard, {
			conversation: {
				id: 'a',
				projectId: 'p',
				title: 'A',
				updatedAt: new Date().toISOString(),
				...(palId ? { palId } : {}),
			},
			project: { id: 'p', path: '/fixture', name: 'Fixture', trusted: true, status: 'ready' },
			active: false,
			onClick: vi.fn(),
			backgroundWork: status,
		}),
	)
}

it('names verified background attention in an ordinary recent row only', () => {
	expect(render()).toContain('data-background-work="attention"')
	expect(render()).toContain('1 process running in background; background work needs attention')
	expect(render('pal')).not.toContain('data-background-work=')
	expect(render(undefined, { ...fresh, expiresAt: Date.now() - 1 })).not.toContain(
		'data-background-work=',
	)
	expect(render(undefined, { ...fresh, runningCount: 0 })).toContain(
		'Background work needs attention',
	)
	expect(render(undefined, { ...fresh, runningCount: 0 })).not.toContain('0 running')
})

function renderWithActions(pinned: boolean, withActions = true) {
	return renderToStaticMarkup(
		createElement(ThreadCard, {
			conversation: {
				id: 'a',
				projectId: 'p',
				title: 'A',
				updatedAt: new Date().toISOString(),
				...(pinned ? { pinned: true as const } : {}),
			},
			project: { id: 'p', path: '/fixture', name: 'Fixture', trusted: true, status: 'ready' },
			active: false,
			onClick: vi.fn(),
			...(withActions
				? {
						rowActions: {
							mac: false,
							input: () => {
								throw new Error('the menu input is only read when the menu opens')
							},
							run: vi.fn(),
							pin: vi.fn(),
							archive: vi.fn(),
						},
					}
				: {}),
		}),
	)
}

it('offers Pin and Archive on hover in place of the more button', () => {
	const html = renderWithActions(false)
	expect(html).toContain('aria-label="Pin"')
	expect(html).toContain('aria-label="Archive"')
	expect(html).not.toContain('Actions for')
	expect(renderWithActions(true)).toContain('aria-label="Unpin"')
	expect(renderWithActions(false, false)).not.toContain('sidebar-thread-actions')
})
