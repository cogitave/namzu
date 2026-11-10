/**
 * The row under a message that says which stored memories went with it:
 * collapsed to a count, one line per memory behind ctrl+o, merged across
 * recalls, and restored from the journal on resume.
 */
import {
	type Message,
	type SessionEvent,
	type SessionRecord,
	createAssistantMessage,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { projectConversation } from '../App.js'
import { builtinToolPresenter, toAgentEvent } from '../agent.js'
import { type UsedMemory, memoryUsedRow, mergeUsedMemories } from '../memory-used-row.js'
import { trailFromRecords } from '../restored-rows.js'

const NOW = Date.UTC(2026, 10, 8, 12)
const DAY = 86_400_000

const note: UsedMemory = {
	id: 'm1',
	name: 'cache-notes',
	title: 'Cache notes',
	origin: 'operator',
	updatedAt: NOW - 3 * DAY,
}
const turn: UsedMemory = {
	id: 'm2',
	title: 'A turn account',
	origin: 'derived',
	updatedAt: NOW,
}

describe('memoryUsedRow', () => {
	it('is none without memories', () => {
		expect(memoryUsedRow([], NOW)).toBeUndefined()
	})

	it('counts in the row and names each memory, who wrote it and its age behind ctrl+o', () => {
		expect(memoryUsedRow([note, turn], NOW)).toEqual({
			content: 'Used 2 memories',
			detail: [
				'Cache notes · you · 3 days ago',
				'A turn account · recorded by a turn · today',
				'/memory delete cache-notes removes one.',
			],
			hint: '(ctrl+o to expand)',
		})
		expect(memoryUsedRow([note], NOW)?.content).toBe('Used 1 memory')
	})

	it('adds the reason a memory was chosen to its line', () => {
		expect(
			memoryUsedRow(
				[
					{ ...note, reason: 'covers cache lifetime' },
					{ ...turn, reason: 'matched words' },
				],
				NOW,
			)?.detail,
		).toEqual([
			'Cache notes · you · 3 days ago · covers cache lifetime',
			'A turn account · recorded by a turn · today · matched words',
			'/memory delete cache-notes removes one.',
		])
	})

	it('falls back to the id when the first memory has no name', () => {
		expect(memoryUsedRow([turn], NOW)?.detail.at(-1)).toBe('/memory delete m2 removes one.')
	})

	it('adds a later recall to the same list and ignores one it already holds', () => {
		const merged = mergeUsedMemories([note], [note, turn])
		expect(merged.map((m) => m.id)).toEqual(['m1', 'm2'])
		expect(mergeUsedMemories(merged, [turn])).toHaveLength(2)
		expect(mergeUsedMemories(merged, [{ ...turn, updatedAt: NOW + 1 }])).toHaveLength(3)
	})
})

describe('memory_recalled in the TUI', () => {
	const event: SessionEvent = {
		type: 'memory_recalled',
		sessionId: 's' as never,
		memories: [
			{ id: 'm1', name: 'cache-notes', title: 'Cache notes', origin: 'operator', updatedAt: 1 },
		],
	}

	it('becomes a memory-recalled event', () => {
		expect(toAgentEvent(event, builtinToolPresenter())).toEqual({
			kind: 'memory-recalled',
			memories: [
				{ id: 'm1', name: 'cache-notes', title: 'Cache notes', origin: 'operator', updatedAt: 1 },
			],
		})
	})

	it('carries the reason through the event and onto a restored row', () => {
		const withReason: SessionEvent = {
			type: 'memory_recalled',
			sessionId: 's' as never,
			memories: [
				{
					id: 'm1',
					title: 'Cache notes',
					origin: 'operator',
					updatedAt: 1,
					reason: 'cache lifetime',
				},
			],
		}
		expect(toAgentEvent(withReason, builtinToolPresenter())).toMatchObject({
			memories: [{ id: 'm1', reason: 'cache lifetime' }],
		})
		const TURN = '00000000-0000-4000-8000-000000000002'
		const messages: Message[] = [
			{ ...createUserMessage('cache?'), id: 'u1' } as Message,
			{ ...createAssistantMessage('Fourteen hours.'), id: 'a1' } as Message,
		]
		const records = [
			...messages.map(
				(message, index) =>
					({
						v: 1,
						id: `m-${index}`,
						seq: 10 + index,
						ts: '2026-11-08T10:00:00.000Z',
						type: 'message',
						sessionId: 's',
						turnId: TURN,
						messageId: message.id,
						role: message.role,
						content: message,
					}) as unknown as SessionRecord,
			),
			{
				v: 1,
				id: 'r1',
				seq: 1,
				ts: '2026-11-08T10:00:00.000Z',
				type: 'memory_recalled',
				sessionId: 's',
				turnId: TURN,
				memories: [
					{
						id: 'm1',
						title: 'Cache notes',
						origin: 'operator',
						updatedAt: 1,
						reason: 'cache lifetime',
					},
				],
			} as unknown as SessionRecord,
		]
		let id = 0
		const rows = projectConversation(messages, () => `row-${++id}`, [], {
			trail: trailFromRecords(records),
		})
		const used = rows.find((row) => row.content === 'Used 1 memory')
		expect(used?.detail?.[0]).toMatch(/^Cache notes · you · .* · cache lifetime$/)
	})

	it('shows the row once before the first reply of a resumed turn, from the journal', () => {
		const TURN = '00000000-0000-4000-8000-000000000001'
		const messages: Message[] = [
			{ ...createUserMessage('cache?'), id: 'u1' } as Message,
			{ ...createAssistantMessage('Fourteen hours.'), id: 'a1' } as Message,
			{ ...createAssistantMessage('And more.'), id: 'a2' } as Message,
		]
		const records = [
			...messages.map(
				(message, index) =>
					({
						v: 1,
						id: `m-${index}`,
						seq: 10 + index,
						ts: '2026-11-08T10:00:00.000Z',
						type: 'message',
						sessionId: 's',
						turnId: TURN,
						messageId: message.id,
						role: message.role,
						content: message,
					}) as unknown as SessionRecord,
			),
			{
				v: 1,
				id: 'r1',
				seq: 1,
				ts: '2026-11-08T10:00:00.000Z',
				type: 'memory_recalled',
				sessionId: 's',
				turnId: TURN,
				memories: [
					{ id: 'm1', name: 'cache-notes', title: 'Cache notes', origin: 'operator', updatedAt: 1 },
				],
			} as unknown as SessionRecord,
		]
		let id = 0
		const rows = projectConversation(messages, () => `row-${++id}`, [], {
			trail: trailFromRecords(records),
		})
		const used = rows.filter((row) => row.content === 'Used 1 memory')
		expect(used).toHaveLength(1)
		expect(used[0]?.detail?.at(-1)).toBe('/memory delete cache-notes removes one.')
		expect(used[0]?.meta).toBe('(ctrl+o to expand)')
		const order = rows.map((row) => row.content)
		expect(order.indexOf('Used 1 memory')).toBe(order.indexOf('Fourteen hours.') - 1)
	})
})
