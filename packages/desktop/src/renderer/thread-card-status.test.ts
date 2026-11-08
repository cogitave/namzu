import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { emptyThread } from '../shared/projection.js'
import type { ThreadState } from '../shared/projection.js'
import type { ConversationView, ProjectView } from '../shared/protocol.js'
import { ThreadCard } from './thread-card.js'

const conversation: ConversationView = {
	id: 'c1',
	projectId: 'p1',
	title: 'Tidy the notes',
	updatedAt: '2026-11-07T10:00:00.000Z',
}
const project = { id: 'p1', name: 'Notes', path: '/notes', trusted: true } as unknown as ProjectView
const request = (name: string) =>
	({
		id: 'r',
		sessionId: 'c1',
		projectId: 'p1',
		calls: [{ id: 'k', name, input: {}, isDestructive: false }],
	}) as unknown as ThreadState['permissions'][number]

function row(options: { thread?: Partial<ThreadState>; unread?: boolean; active?: boolean } = {}) {
	return renderToStaticMarkup(
		createElement(ThreadCard, {
			conversation,
			project,
			thread: options.thread ? { ...emptyThread(), ...options.thread } : undefined,
			active: options.active ?? false,
			unread: options.unread,
			onClick: () => {},
		}),
	)
}

it('shows the age and no status for a quiet conversation', () => {
	const html = row()
	expect(html).toContain('conversation-age')
	expect(html).not.toContain('data-status')
	expect(html).not.toContain('thread-unread-dot')
})

it('shows an unread dot with a name, a firmer title hook, and the status line in words', () => {
	const html = row({ unread: true })
	expect(html).toContain('data-status="unread"')
	expect(html).toContain('class="thread-unread-dot" role="img" aria-label="New reply"')
	expect(html).toContain('<span id=')
	expect(html).toContain('>New reply</span>')
	expect(html).not.toContain('conversation-age')
})

it('shows one mark per row, the most pressing one, each with words', () => {
	expect(row({ thread: { running: true }, unread: true })).toContain('aria-label="Running"')
	expect(row({ thread: { running: true }, unread: true })).not.toContain('New reply')
	expect(row({ thread: { error: 'x' }, unread: true })).toContain('aria-label="Needs attention"')
	expect(row({ thread: { permissions: [request('write_file')] } })).toContain(
		'aria-label="Approval needed"',
	)
	const question = row({ thread: { permissions: [request('ask_user_question')] } })
	expect(question).toContain('aria-label="Question waiting"')
	expect(question).not.toContain('Approval needed')
})

it('does not show a stopped turn as running', () => {
	const html = row({ thread: { running: true, stopReason: 'cancelled' } })
	expect(html).not.toContain('aria-label="Running"')
})
