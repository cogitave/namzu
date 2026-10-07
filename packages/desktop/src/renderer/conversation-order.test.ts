import { expect, it } from 'vitest'
import type { ConversationView } from '../shared/protocol.js'
import { compareConversationOrder, compareConversationRecency } from './conversation-order.js'

const conversations: ConversationView[] = [
	{ id: 'c', projectId: 'docs', title: 'Notes', updatedAt: '2026-10-01T09:00:00Z' },
	{ id: 'a', projectId: 'app', title: 'Navigation', updatedAt: '2026-10-01T09:00:00Z' },
	{ id: 'b', projectId: 'app', title: 'Composer', updatedAt: '2026-10-01T09:00:00Z' },
]
const orderedIds = (rows: ConversationView[]) =>
	[...rows].sort(compareConversationRecency).map((row) => row.id)

it('retains equal-date order when project refreshes replace and append their records', () => {
	const initialOrder = orderedIds(conversations)
	let refreshed = [...conversations]
	for (const projectId of ['docs', 'app', 'docs']) {
		const returned = conversations
			.filter((row) => row.projectId === projectId)
			.reverse()
			.map((row) => ({ ...row, title: `${row.title} refreshed` }))
		refreshed = [...refreshed.filter((row) => row.projectId !== projectId), ...returned]
		expect(orderedIds(refreshed)).toEqual(initialOrder)
	}
})

it('moves a conversation for a newer saved timestamp while retaining the remaining order', () => {
	const refreshed = conversations.map((row) =>
		row.id === 'c' ? { ...row, updatedAt: '2026-10-01T10:00:00Z' } : row,
	)
	expect(orderedIds(refreshed)[0]).toBe('c')
	expect(orderedIds(refreshed).slice(1)).toEqual(
		orderedIds(conversations).filter((id) => id !== 'c'),
	)
})

it('puts pinned conversations first and keeps recency inside each side', () => {
	const rows: ConversationView[] = [
		{ id: 'new', projectId: 'p', title: 'New', updatedAt: '2026-10-03T09:00:00Z' },
		{
			id: 'old-pinned',
			projectId: 'p',
			title: 'Old',
			updatedAt: '2026-10-01T09:00:00Z',
			pinned: true,
		},
		{ id: 'mid', projectId: 'p', title: 'Mid', updatedAt: '2026-10-02T09:00:00Z' },
		{
			id: 'new-pinned',
			projectId: 'p',
			title: 'Pinned',
			updatedAt: '2026-10-04T09:00:00Z',
			pinned: true,
		},
	]
	expect([...rows].sort(compareConversationOrder).map((row) => row.id)).toEqual([
		'new-pinned',
		'old-pinned',
		'new',
		'mid',
	])
})

it('unpinning returns a conversation to its recency position', () => {
	const rows: ConversationView[] = [
		{ id: 'a', projectId: 'p', title: 'A', updatedAt: '2026-10-03T09:00:00Z' },
		{ id: 'b', projectId: 'p', title: 'B', updatedAt: '2026-10-01T09:00:00Z', pinned: true },
	]
	const unpinned = rows.map(({ pinned: _pinned, ...row }) => row)
	expect([...unpinned].sort(compareConversationOrder).map((row) => row.id)).toEqual(['a', 'b'])
})
