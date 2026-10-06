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
