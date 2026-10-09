import { expect, it } from 'vitest'
import { emptyProjectConversation, reusableProjectDraft } from './project-draft-reuse.js'

const base = {
	candidate: 'draft-1',
	projectId: 'app',
	conversations: [{ id: 'draft-1', projectId: 'app' }],
	thread: { messages: [], running: false },
	draftText: '',
}

it('reuses the untouched draft last opened for the project', () => {
	expect(reusableProjectDraft(base)).toBe('draft-1')
	expect(reusableProjectDraft({ ...base, thread: undefined })).toBe('draft-1')
})

it('creates a new draft when there is none, or it was used, typed into or removed', () => {
	expect(reusableProjectDraft({ ...base, candidate: undefined })).toBeUndefined()
	expect(
		reusableProjectDraft({
			...base,
			thread: { messages: [{}], running: false },
		}),
	).toBeUndefined()
	expect(reusableProjectDraft({ ...base, thread: { messages: [], running: true } })).toBeUndefined()
	expect(reusableProjectDraft({ ...base, draftText: 'hello' })).toBeUndefined()
	expect(reusableProjectDraft({ ...base, conversations: [] })).toBeUndefined()
	expect(
		reusableProjectDraft({
			...base,
			conversations: [{ id: 'draft-1', projectId: 'other' }],
		}),
	).toBeUndefined()
})

it('finds the newest untouched conversation of the project after a restart', () => {
	const rows = [
		{ id: 'a', projectId: 'app', title: 'New conversation', updatedAt: '2026-10-01T00:00:00Z' },
		{ id: 'b', projectId: 'app', title: 'New conversation', updatedAt: '2026-10-02T00:00:00Z' },
		{ id: 'c', projectId: 'app', title: 'Fix the build', updatedAt: '2026-10-03T00:00:00Z' },
		{ id: 'd', projectId: 'docs', title: 'New conversation', updatedAt: '2026-10-04T00:00:00Z' },
		{
			id: 'e',
			projectId: 'app',
			palId: 'pal',
			title: 'New conversation',
			updatedAt: '2026-10-05T00:00:00Z',
		},
	]
	expect(emptyProjectConversation(rows, 'app')).toBe('b')
	expect(emptyProjectConversation(rows, 'none')).toBeUndefined()
})
