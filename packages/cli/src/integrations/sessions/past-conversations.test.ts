import type { SessionId } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { searchPastConversations } from './past-conversations.js'
import type { ConversationContext } from './store.js'

const id = (n: number) => `019a0000-0000-7000-8000-00000000000${n}` as SessionId

interface Row {
	id: SessionId
	projectId: string
	archived: boolean
	updatedAt: string
	title?: string
	parentId?: SessionId
}
interface Hit {
	sessionId: SessionId
	source: string
	toolName?: string
	excerpt: string
}

function sessionsOf(rows: Row[], hits: Hit[]): ConversationContext {
	return {
		slug: 'project-a',
		projectId: 'project-a',
		index: {
			// The index lists what the caller asks for: this project's roots, archived or not.
			async listSessions(options: { rootsOnly?: boolean; includeArchived?: boolean }) {
				return rows.filter(
					(row) =>
						(!options.rootsOnly || row.parentId === undefined) &&
						(options.includeArchived !== false || !row.archived),
				)
			},
			async searchEvidence() {
				return hits
			},
		},
	} as unknown as ConversationContext
}

const row = (n: number, over: Partial<Row> = {}): Row => ({
	id: id(n),
	projectId: 'project-a',
	archived: false,
	updatedAt: `2026-11-0${n}T10:00:00.000Z`,
	title: `Chat ${n}`,
	...over,
})
const reply = (n: number, excerpt: string): Hit => ({
	sessionId: id(n),
	source: 'message_completed',
	excerpt,
})

describe('searching earlier conversations of this project', () => {
	it('returns one excerpt per conversation, newest first, and leaves out the current one', async () => {
		const sessions = sessionsOf(
			[row(1), row(2), row(3)],
			[
				reply(1, 'we chose the blue invoice template'),
				reply(2, 'the invoice job runs nightly'),
				reply(2, 'invoice again'),
				reply(3, 'invoice here'),
			],
		)
		const found = await searchPastConversations(sessions, id(3), { query: 'invoice' })
		expect(found.map((m) => m.title)).toEqual(['Chat 2', 'Chat 1'])
		expect(found[0]?.excerpt).toContain('invoice job runs nightly')
		expect(Object.keys(found[0] ?? {}).sort()).toEqual(['excerpt', 'title', 'updatedAt'])
	})

	it('never reaches an archived conversation, another project or a child session', async () => {
		const sessions = sessionsOf(
			[
				row(1, { archived: true }),
				row(2, { projectId: 'project-b' }),
				row(3, { parentId: id(9) }),
				row(4),
			],
			[reply(1, 'invoice a'), reply(2, 'invoice b'), reply(3, 'invoice c'), reply(4, 'invoice d')],
		)
		const found = await searchPastConversations(sessions, id(5), { query: 'invoice' })
		expect(found.map((m) => m.title)).toEqual(['Chat 4'])
	})

	it('quotes no tool output and honours the limit', async () => {
		const secret = 'api_key=sk-live-123'
		const sessions = sessionsOf(
			[row(1), row(2), row(3)],
			[
				{ sessionId: id(1), source: 'tool_completed', toolName: 'read', excerpt: secret },
				reply(2, 'a'),
				reply(3, 'b'),
			],
		)
		const found = await searchPastConversations(sessions, id(9), { query: 'api_key', limit: 2 })
		expect(found).toHaveLength(2)
		expect(JSON.stringify(found)).not.toContain('sk-live')
		const all = await searchPastConversations(sessions, id(9), { query: 'api_key' })
		expect(all.some((m) => m.excerpt === 'Found in what “read” returned')).toBe(true)
	})

	it('answers nothing for a query too short to mean anything', async () => {
		const sessions = sessionsOf([row(1)], [reply(1, 'x')])
		expect(await searchPastConversations(sessions, id(9), { query: 'x' })).toEqual([])
	})
})
