import type { SessionId } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { searchPastConversations } from './past-conversations.js'
import type { ConversationContext } from './store.js'

const id = '019a0000-0000-7000-8000-000000000001' as SessionId

const readConversationRecords = vi.fn()
vi.mock('./store.js', () => ({
	readConversationRecords: (...args: unknown[]) => readConversationRecords(...args),
	displayTitleOf: (facts: { shown: string }) => facts.shown,
}))

function sessionsOf(title: string | undefined): ConversationContext {
	return {
		slug: 'project-a',
		projectId: 'project-a',
		index: {
			async listSessions() {
				return [
					{
						id,
						projectId: 'project-a',
						archived: false,
						updatedAt: '2026-11-01T10:00:00.000Z',
						...(title === undefined ? {} : { title }),
					},
				]
			},
			async searchEvidence() {
				return [{ sessionId: id, source: 'message_completed', excerpt: 'the invoice job' }]
			},
		},
	} as unknown as ConversationContext
}

describe('the title a past-conversation match carries', () => {
	it('is the one the sidebar shows, taken from the first message when nobody named it', async () => {
		readConversationRecords.mockResolvedValue({ shown: 'Plan the launch' })
		const [match] = await searchPastConversations(sessionsOf(undefined), 'x' as SessionId, {
			query: 'invoice',
		})
		expect(match?.title).toBe('Plan the launch')
	})

	it('falls back to the indexed title, then a plain label, when the log cannot be read', async () => {
		readConversationRecords.mockRejectedValue(new Error('unreadable'))
		const named = await searchPastConversations(sessionsOf('Chat'), 'x' as SessionId, {
			query: 'invoice',
		})
		expect(named[0]?.title).toBe('Chat')
		const bare = await searchPastConversations(sessionsOf(undefined), 'x' as SessionId, {
			query: 'invoice',
		})
		expect(bare[0]?.title).toBe('Untitled conversation')
	})
})
