import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { emptyThread } from '../shared/projection.js'
import type { ThreadState } from '../shared/projection.js'
import type { ConversationView, ProjectView } from '../shared/protocol.js'
import { setStatusMarks, statusMarksFrom } from './status-marks.js'
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

it('shows no mark when the setting is off, and the row is otherwise the same', () => {
	setStatusMarks(false)
	try {
		const html = row({
			thread: { running: true, error: 'x', permissions: [request('write_file')] },
			unread: true,
		})
		expect(html).not.toContain('data-status')
		expect(html).not.toContain('thread-unread-dot')
		expect(html).not.toContain('Running')
		expect(html).not.toContain('Approval needed')
		expect(html).toContain('Tidy the notes')
	} finally {
		setStatusMarks(true)
	}
})

it('reads the setting: on unless it says off, and the layer in force wins', () => {
	const view = (state: Record<string, unknown>) =>
		({
			file: '',
			descriptors: [],
			settings: [{ path: 'statusMarks', set: true, ...state }],
		}) as never
	expect(statusMarksFrom(undefined)).toBe(true)
	expect(statusMarksFrom(view({ set: false }))).toBe(true)
	expect(statusMarksFrom(view({ value: false }))).toBe(false)
	expect(statusMarksFrom(view({ value: false, effective: true }))).toBe(true)
	expect(statusMarksFrom(view({ value: true, effective: false }))).toBe(false)
})
