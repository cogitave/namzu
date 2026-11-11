import { describe, expect, it } from 'vitest'
import {
	InMemorySessionLog,
	type SessionLease,
	type SessionLog,
} from '../../../store/session-log/index.js'
import type { ProjectId, TenantId, TopicId } from '../../../types/ids/index.js'
import { createAssistantMessage, createUserMessage } from '../../../types/message/index.js'
import { generateMessageId, generateSessionId, generateTurnId } from '../../../utils/id.js'
import { readEverRecordedMessages, readFoldedHistory } from '../turn-recorder.js'

type Draft = Parameters<SessionLog['append']>[1]

/**
 * A new turn reads the session's folded context back from its log. That used
 * to fold every record the session had ever written, every turn; it now folds
 * the records appended since the last read. What it hands back must be what a
 * fresh fold hands back, and the caller's copy must be its own.
 */
async function openLog() {
	const log = new InMemorySessionLog({ sessionId: generateSessionId() })
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
	let n = 0
	const say = async (text: string) => {
		const message = n++ % 2 === 0 ? createUserMessage(text) : createAssistantMessage(text)
		await log.append(lease, {
			turnId,
			type: 'message',
			messageId: generateMessageId(),
			role: message.role,
			content: message,
		} as Draft)
	}
	return { log, say }
}

/** A fold to a seq is read in full every time: the uncached path, for comparison. */
async function freshFold(log: InMemorySessionLog) {
	return readFoldedHistory(log, { throughSeq: Number.MAX_SAFE_INTEGER })
}

describe('the folded history read at the start of a turn', () => {
	it('is what a fresh fold gives, after every append', async () => {
		const { log, say } = await openLog()
		for (let i = 0; i < 6; i++) {
			await say(`message ${i}`)
			const warm = await readFoldedHistory(log)
			expect(warm).toEqual(await freshFold(log))
			expect(warm).toHaveLength(i + 1)
		}
	})

	it('hands the caller its own copy: changing it changes nothing for the next turn', async () => {
		const { log, say } = await openLog()
		await say('first')
		await say('second')
		const mine = await readFoldedHistory(log)
		const original = structuredClone(mine)
		const text = mine[0]?.message as { content: unknown }
		text.content = 'overwritten by a caller'
		mine.pop()
		expect(await readFoldedHistory(log)).toEqual(original)
	})

	it('has every message the session recorded, and a copy of each', async () => {
		const { log, say } = await openLog()
		await say('first')
		const before = await readEverRecordedMessages(log)
		await say('second')
		const after = await readEverRecordedMessages(log)
		expect(before.size).toBe(1)
		expect(after.size).toBe(2)
		for (const [id, message] of before) {
			expect(after.get(id)).toEqual(message)
			expect(after.get(id)).not.toBe(message)
		}
	})
})
