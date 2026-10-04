import { type ComponentProps, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { ConversationTabs } from './conversation-tabs.js'
import { Wordmark, WordmarkInitial } from './wordmark.js'

function render(overrides: Partial<ComponentProps<typeof ConversationTabs>> = {}) {
	return renderToStaticMarkup(
		createElement(ConversationTabs, {
			tabs: [
				{ id: 'ordinary', projectId: 'project', title: 'First thread', updatedAt: '' },
				{
					id: 'native',
					projectId: 'project',
					title: 'Native thread',
					updatedAt: '',
					harness: 'codex-cli',
				},
			],
			active: 'ordinary',
			busy: false,
			running: () => false,
			onSelect: vi.fn(),
			onClose: vi.fn(),
			onNew: vi.fn(),
			...overrides,
		}),
	)
}

it('uses exactly the canonical N glyph while leaving the complete wordmark unchanged', () => {
	const full = renderToStaticMarkup(createElement(Wordmark))
	const initial = renderToStaticMarkup(createElement(WordmarkInitial))
	expect(initial).toContain('>█▄ █\n█ ▀█</pre>')
	expect(full).toContain('>█▄ █ ▄▀█ █▀▄▀█ ▀█ █ █\n█ ▀█ █▀█ █ ▀ █ █▄ █▄█</pre>')
	const html = render()
	expect(html).toContain(initial)
	expect(html).not.toContain(full)
	expect(html).toContain('aria-label="Namzu: First thread"')
	expect(html).toContain('aria-label="Codex CLI: Native thread"')
	expect(html.match(/class="conversation-tab-mark"/g)).toHaveLength(2)
	expect(html).toContain('aria-label="Close tab First thread"')
	expect(html).toContain('aria-label="Close tab Native thread"')
})

it('preserves the same identity slot and accessible tab title when a conversation starts working', () => {
	const idle = render()
	const running = render({ running: (id) => id === 'ordinary' })
	expect(running.match(/class="conversation-tab-mark"/g)).toHaveLength(2)
	expect(running).toContain('animate-spin')
	expect(running).not.toContain('namzu-wordmark initial')
	for (const label of ['Namzu: First thread', 'Close tab First thread', 'New conversation tab']) {
		expect(idle).toContain(`aria-label="${label}"`)
		expect(running).toContain(`aria-label="${label}"`)
	}
})

it('keeps tab selection, closing and creation disabled while their real owner is busy', () => {
	const html = render({ busy: true })
	for (const label of [
		'Namzu: First thread',
		'Codex CLI: Native thread',
		'Close tab First thread',
		'Close tab Native thread',
		'New conversation tab',
	]) {
		const button = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0]
		expect(button).toMatch(/\bdisabled=/)
	}
})
