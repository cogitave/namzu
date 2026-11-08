import { describe, expect, it } from 'vitest'
import { holdsDiscardableDraft } from './discard-draft.js'

const fresh = { title: 'New conversation' }
const base = { view: fresh, thread: undefined, draft: '', attachmentCount: 0 }

describe('holdsDiscardableDraft', () => {
	it('asks for a draft pane with typed text or attachments', () => {
		expect(holdsDiscardableDraft({ ...base, draft: 'half a message' })).toBe(true)
		expect(holdsDiscardableDraft({ ...base, attachmentCount: 1 })).toBe(true)
	})

	it('lets an untouched or blank draft pane close', () => {
		expect(holdsDiscardableDraft(base)).toBe(false)
		expect(holdsDiscardableDraft({ ...base, draft: '  \n ' })).toBe(false)
	})

	it('leaves a conversation that has messages alone: its unsent text is kept as before', () => {
		const thread = { messages: [{}], running: false }
		expect(holdsDiscardableDraft({ ...base, draft: 'follow-up', thread })).toBe(false)
		expect(holdsDiscardableDraft({ ...base, draft: 'x', view: { title: 'Fix the build' } })).toBe(
			false,
		)
	})

	it('leaves a running conversation and a Pal alone', () => {
		expect(
			holdsDiscardableDraft({ ...base, draft: 'x', thread: { messages: [], running: true } }),
		).toBe(false)
		expect(holdsDiscardableDraft({ ...base, draft: 'x', view: { ...fresh, palId: 'p' } })).toBe(
			false,
		)
	})

	it('has nothing to ask about a conversation that does not exist', () => {
		expect(holdsDiscardableDraft({ ...base, draft: 'x', view: undefined })).toBe(false)
	})
})
