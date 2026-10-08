import { expect, it } from 'vitest'
import type { DesktopConversationSnapshot } from './desktop-conversation-store.js'
import { parseUntrust, projectBusyReason, withoutProject } from './project-removal.js'

const idle = (id: string, over: Record<string, unknown> = {}) => ({
	view: { id },
	running: false,
	admitting: undefined,
	queue: [] as unknown[],
	permissions: new Map(),
	reattaching: undefined,
	selectionPending: undefined,
	...over,
})

it('names a running reply, a queue or a pending permission as the reason to wait', () => {
	const none = new Set<string>()
	expect(projectBusyReason('App', [idle('a'), idle('b')], none)).toBeUndefined()
	for (const over of [
		{ running: true },
		{ admitting: Symbol('send') },
		{ queue: [1] },
		{ permissions: new Map([['x', 1]]) },
	])
		expect(projectBusyReason('App', [idle('a'), idle('b', over)], none)).toMatch(
			/reply is still running in App/,
		)
	expect(projectBusyReason('App', [idle('a', { reattaching: Promise.resolve() })], none)).toMatch(
		/still changing/,
	)
	expect(projectBusyReason('App', [idle('a')], new Set(['a']))).toMatch(/still changing/)
})

it('reduces the host answer to what a person is told', () => {
	expect(parseUntrust({ cwd: '/p', removed: true, trusted: false })).toEqual({ state: 'removed' })
	expect(parseUntrust({ removed: false, trusted: false })).toEqual({ state: 'removed' })
	expect(parseUntrust({ removed: true, trusted: true, stillTrustedBy: '/home' })).toEqual({
		state: 'still-trusted',
		by: '/home',
	})
	expect(parseUntrust({ removed: true, trusted: true })).toEqual({ state: 'still-trusted', by: '' })
	for (const bad of [null, 'x', {}, { removed: 'yes', trusted: false }, { removed: true }])
		expect(() => parseUntrust(bad)).toThrow('invalid answer')
})

it('forgets exactly one project in the saved state', () => {
	const base = (id: string) => ({
		view: { id: `c-${id}`, projectId: id, title: 't', updatedAt: '2026-10-01T00:00:00.000Z' },
		runtimeSessionId: `r-${id}`,
		hasPrompted: false,
		draft: '',
	})
	const attachment = (ownerId: string) =>
		({ ownerId, draft: true, view: { id: `f-${ownerId}` } }) as never
	const snapshot: DesktopConversationSnapshot = {
		version: 1,
		projects: [
			{ id: 'a', path: '/a' },
			{ id: 'b', path: '/b' },
		],
		conversations: [base('a'), base('b')],
		projectDrafts: [
			{ ownerId: 'project:a', draft: 'x' },
			{ ownerId: 'project:b', draft: 'y' },
		],
		attachments: [attachment('c-a'), attachment('c-b'), attachment('project:a')],
		lastModels: { namzu: { provider: 'p', model: 'm' } },
	}
	const next = withoutProject(
		snapshot,
		'a',
		(owner) => owner === 'project:a',
		new Set(['c-a', 'project:a']),
	)
	expect(next.projects).toEqual([{ id: 'b', path: '/b' }])
	expect(next.conversations.map((item) => item.view.id)).toEqual(['c-b'])
	expect(next.projectDrafts.map((item) => item.ownerId)).toEqual(['project:b'])
	expect(next.attachments.map((item) => item.ownerId)).toEqual(['c-b'])
	expect(next.lastModels).toEqual(snapshot.lastModels)
	// The input is not modified.
	expect(snapshot.projects).toHaveLength(2)
})
