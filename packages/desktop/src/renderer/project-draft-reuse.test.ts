import { expect, it } from 'vitest'
import { reusableProjectDraft } from './project-draft-reuse.js'

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
