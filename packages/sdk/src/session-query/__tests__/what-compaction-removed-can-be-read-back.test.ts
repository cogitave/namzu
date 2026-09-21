import { describe, expect, it } from 'vitest'

import {
	InMemoryLogMedium,
	InMemorySessionLog,
	type SessionLease,
	type SessionLog,
} from '../../store/session-log/index.js'
import type { MessageId, ProjectId, SessionId, TenantId, TopicId } from '../../types/ids/index.js'
import { createAssistantMessage, createUserMessage } from '../../types/message/index.js'
import type { Message } from '../../types/message/index.js'
import {
	generateCheckpointId,
	generateMessageId,
	generateSessionId,
	generateTurnId,
} from '../../utils/id.js'
import { SessionQuery, SessionTranscriptUnavailableError } from '../index.js'

/**
 * Asking a session what happened.
 *
 * The log's fold is what survived compaction; what compaction removed lives
 * only in the log's `compaction_shed` records, "exactly the messages the pass
 * removed". Evidence nobody can retrieve is evidence nobody kept, so the
 * query reads both back from the one log.
 */

type Draft = Parameters<SessionLog['append']>[1]

/** A session log with one open turn, and a way to append records to it. */
async function openTurn(options: { spillAboveBytes?: number } = {}) {
	const sessionId = generateSessionId()
	const log = new InMemorySessionLog({
		sessionId,
		...(options.spillAboveBytes !== undefined ? { spillAboveBytes: options.spillAboveBytes } : {}),
	})
	const lease = (await log.claim({ holder: 'test', ttlMs: 60_000 })) as SessionLease
	await log.append(lease, {
		type: 'session_started',
		projectId: '4dfa889d-312b-4570-a8e3-e1ccd3f2274b' as ProjectId,
		tenantId: '2c8e25c0-8fc7-4427-8e9e-f338d6e51c02' as TenantId,
		topicId: '07c17470-7e89-4c5e-9680-2d10d92ac22a' as TopicId,
		cwd: '/tmp',
		agent: { id: 'a', name: 'A' },
	} as Draft)
	const turnId = generateTurnId()
	await log.beginTurn(lease, {
		turnId,
		userMessageId: generateMessageId(),
		config: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
	})
	const append = (draft: Record<string, unknown>) =>
		log.append(lease, { turnId, ...draft } as Draft)
	const message = async (content: Message): Promise<MessageId> => {
		const messageId = generateMessageId()
		await append({ type: 'message', messageId, role: content.role, content })
		return messageId
	}
	const shed = (messages: Message[], over: Record<string, unknown> = {}) =>
		append({ type: 'compaction_shed', iteration: 1, reason: 'threshold', messages, ...over })
	const complete = () =>
		append({
			type: 'turn_completed',
			result: 'done',
			settlement: {
				status: 'completed',
				iterations: 1,
				usage: {
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					cacheWriteTokens: 0,
				},
				cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
				durationMs: 1,
				resultSource: 'model',
				abandonedTaskIds: [],
				abandonedJobIds: [],
			},
		})
	/** A park: the turn asks a human, naming a checkpoint. */
	const park = () => {
		const checkpointId = generateCheckpointId()
		return append({
			type: 'decision_requested',
			decisionId: checkpointId,
			checkpointId,
			request: { type: 'tool_review', sessionId, turnId, checkpointId, toolCalls: [] },
		})
	}
	return { sessionId, log, lease, turnId, append, message, shed, complete, park }
}

/** The same bytes in a new medium, with the given edit applied to them. */
async function copyWith(
	log: InMemorySessionLog,
	sessionId: SessionId,
	edit: (text: string) => string,
): Promise<InMemorySessionLog> {
	const size = await log.medium.size()
	const text = Buffer.from(await log.medium.read(0, size)).toString('utf8')
	const medium = new InMemoryLogMedium()
	await medium.append(Buffer.from(edit(text), 'utf8'), 0)
	return new InMemorySessionLog({ sessionId, medium })
}

describe('what compaction removed can be read back', () => {
	it('returns every shed pass, oldest first', async () => {
		const turn = await openTurn()
		const first = [createUserMessage('the first thing')]
		const second = [createUserMessage('the second thing')]
		await turn.shed(first, { iteration: 3 })
		await turn.append({ type: 'iteration_started', iteration: 4 })
		await turn.shed(second, { iteration: 7, reason: 'overflow' })

		const passes = await new SessionQuery({ log: turn.log }).shedHistory()

		expect(passes.map((p) => p.iteration)).toEqual([3, 7])
		expect(passes.map((p) => p.reason)).toEqual(['threshold', 'overflow'])
		expect(passes[0]?.messages).toEqual(first)
	})

	it('carries the log position, for a caller correlating with events', async () => {
		const turn = await openTurn()
		const entry = await turn.shed([createUserMessage('gone')])

		expect((await new SessionQuery({ log: turn.log }).shedHistory())[0]?.seq).toBe(entry.record.seq)
	})

	it('says nothing for a session that never compacted', async () => {
		const turn = await openTurn()
		expect(await new SessionQuery({ log: turn.log }).shedHistory()).toEqual([])
	})
})

describe('the full transcript is complete', () => {
	it('folds the surviving conversation from the log when none is supplied', async () => {
		const turn = await openTurn()
		const gone = createUserMessage('the durable instruction')
		await turn.message(gone)
		await turn.shed([gone])
		await turn.append({
			type: 'compaction',
			compactionId: generateMessageId(),
			strategy: 'context-rewrite',
			trigger: 'auto',
			replacesSeqRange: [1, 4],
			summary: [],
			keptMessageIds: [],
			tokensBefore: 0,
			tokensAfter: 0,
		})
		await turn.message(createAssistantMessage('the durable summary'))
		await turn.complete()

		const full = await new SessionQuery({ log: turn.log }).fullTranscript()

		expect(full.map((message) => message.content)).toEqual([
			'the durable instruction',
			'the durable summary',
		])
	})

	it('refuses a log that does not chain', async () => {
		const turn = await openTurn()
		await turn.message(createUserMessage('what was said'))
		await turn.shed([createUserMessage('what was shed')])
		await turn.complete()
		// A record changed after it was written: its hash no longer chains.
		const broken = await copyWith(turn.log, turn.sessionId, (text) =>
			text.replace('what was said', 'what was NOT said'),
		)

		const refusal = await new SessionQuery({ log: broken })
			.fullTranscript()
			.catch((error: unknown) => error)

		expect(refusal).toBeInstanceOf(SessionTranscriptUnavailableError)
		expect(refusal).toMatchObject({ reason: 'log-integrity' })
	})

	it('refuses a transcript whose spilled message body is gone', async () => {
		const turn = await openTurn({ spillAboveBytes: 64 })
		await turn.message(createUserMessage(`a long body ${'x'.repeat(512)}`))
		await turn.complete()
		// The same log without its spill store: the record names a body the
		// reader cannot find.
		const withoutSpills = await copyWith(turn.log, turn.sessionId, (text) => text)

		const refusal = await new SessionQuery({ log: withoutSpills })
			.fullTranscript()
			.catch((error: unknown) => error)

		expect(refusal).toBeInstanceOf(SessionTranscriptUnavailableError)
		expect(refusal).toMatchObject({ reason: 'spill-unavailable' })
	})

	it('carries a message compaction removed AND the ones that survived', async () => {
		// The question somebody reconstructing an incident is actually asking.
		const turn = await openTurn()
		const gone = createUserMessage('the instruction that was shed')
		const survived = [createAssistantMessage('a summary'), createUserMessage('and then')]
		await turn.shed([gone])

		const full = await new SessionQuery({ log: turn.log }).fullTranscript(survived)

		expect(full).toHaveLength(3)
		expect(full[0]).toEqual(gone)
		expect(full.slice(1)).toEqual(survived)
	})

	it('returns the SAME array when nothing was shed', async () => {
		// So the common case costs one log read and no allocation.
		const turn = await openTurn()
		const messages = [createUserMessage('hello')]

		expect(await new SessionQuery({ log: turn.log }).fullTranscript(messages)).toBe(messages)
	})

	it('keeps two passes in the order they happened', async () => {
		const turn = await openTurn()
		await turn.shed([createUserMessage('A')])
		await turn.shed([createUserMessage('B')])

		const full = await new SessionQuery({ log: turn.log }).fullTranscript([createUserMessage('C')])

		expect(full.map((m) => m.content)).toEqual(['A', 'B', 'C'])
	})
})

describe('status comes from the read model, not a second fold', () => {
	it('answers about a finished turn', async () => {
		// Two folds of one log are two chances to disagree, and a turn that
		// reads differently depending on which surface asked is what this
		// seam exists to remove.
		const turn = await openTurn()
		await turn.complete()

		expect(await new SessionQuery({ log: turn.log }).status()).toBe('succeeded')
	})

	it('answers about a turn waiting on a human', async () => {
		const turn = await openTurn()
		await turn.park()

		expect(await new SessionQuery({ log: turn.log }).status()).toBe('awaiting_hitl')
	})

	it('hands back the whole projected state for a caller that wants the park', async () => {
		const turn = await openTurn()
		await turn.park()

		const state = await new SessionQuery({ log: turn.log }).statusState()

		expect(state.execution).toBe('running')
		expect(state.park).toBeDefined()
	})

	it('says queued for a session whose log is empty', async () => {
		const log = new InMemorySessionLog({ sessionId: generateSessionId() })
		expect(await new SessionQuery({ log }).status()).toBe('queued')
	})
})

describe('the records themselves', () => {
	it('are handed back oldest first, as the log holds them', async () => {
		// Not re-sorted: the log is one append-only sequence.
		const turn = await openTurn()
		await turn.append({ type: 'iteration_started', iteration: 1 })

		const records = await new SessionQuery({ log: turn.log }).records()

		expect(records.map((record) => record.type)).toEqual([
			'session_started',
			'turn_started',
			'iteration_started',
		])
		expect(records.map((record) => record.seq)).toEqual([1, 2, 3])
	})
})
