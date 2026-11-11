import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog, type SessionLease } from '../../../store/session-log/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SessionRecord } from '../../../types/session/records.js'
import { generateMessageId, generateSessionId, generateTurnId } from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { terminalRecords } from './support/session.js'

/**
 * A host that resends id-bearing history it cached before a compaction pass
 * holds the text each message had before its edit. Accepting that text must
 * not read the log again per message: the count of `log.read` calls is the
 * same for 2 edited messages as for 8. Every number here is a count of calls.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const turnConfig = { model: 'mock', timeoutMs: 20_000, tokenBudget: 100_000, maxIterations: 4 }

function scopeFor(sessionId: SessionId) {
	return {
		sessionId,
		topicId: 'e35b1a02-6d94-4f7a-9d3e-6a6f2e8b5a11' as TopicId,
		projectId: 'a3c9d2e1-4b7f-4a9c-8e2d-1f5a9c3b7d22' as ProjectId,
		tenantId: '9d4e2a1b-7c6f-4e8d-b3a1-2c5d9e8f4a33' as TenantId,
	}
}

function query(log: InMemorySessionLog, messages: readonly Message[], reply: string) {
	return drainQuery({
		provider: new MockLLMProvider({ responseText: reply }),
		toolsets: [],
		messages: [...messages],
		workingDirectory: '/tmp',
		sessionLog: log,
		turnConfig,
		agentId: 'edit-reads',
		agentName: 'Edit reads',
		...scopeFor(log.sessionId),
	})
}

/** A session of `turns` turns; the host's cache is the messages the last turn returned. */
async function session(turns: number) {
	const log = new InMemorySessionLog({ sessionId: generateSessionId() })
	let cached: Message[] = []
	for (let turn = 0; turn < turns; turn++) {
		const run = await query(
			log,
			[...cached, createUserMessage(`question ${turn}`)],
			`answer ${turn}`,
		)
		expect(run.status).toBe('completed')
		cached = [...run.messages]
	}
	return { log, cached }
}

type Draft = Parameters<InMemorySessionLog['append']>[1]

/** Append records inside a turn of their own, then close it. */
async function appendInTurn(log: InMemorySessionLog, drafts: readonly Draft[]) {
	const lease = (await log.claim({ holder: 'test', ttlMs: 60_000 })) as SessionLease
	const turnId = generateTurnId()
	await log.beginTurn(lease, {
		turnId,
		userMessageId: generateMessageId(),
		config: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
	})
	for (const draft of drafts) await log.append(lease, { ...draft, turnId } as Draft)
	// Close it the way an earlier turn of this log was closed.
	const { settlement, result } = (await terminalRecords(log)).find(
		(r) => r.type === 'turn_completed',
	) as Extract<SessionRecord, { type: 'turn_completed' }>
	await log.append(lease, { type: 'turn_completed', turnId, result, settlement } as Draft)
	await log.release(lease)
}

/** Append `message_edited` records for the given messages, as a compaction pass does. */
async function edit(log: InMemorySessionLog, edits: readonly [Message, string][]) {
	await appendInTurn(
		log,
		edits.map(
			([message, content]) =>
				({
					type: 'message_edited',
					targetMessageId: message.id,
					content: withText(message, content),
					ignorable: true,
					reason: 'compaction',
				}) as unknown as Draft,
		),
	)
}

const withText = (message: Message, content: unknown): Message =>
	({ ...message, content }) as Message

const assistants = (cached: readonly Message[]) => cached.filter((m) => m.role === 'assistant')

/** Resend `cached` and count the whole-log reads the turn made. */
async function resendCounting(log: InMemorySessionLog, cached: readonly Message[]) {
	const read = vi.spyOn(log, 'read')
	try {
		const run = await query(log, [...cached, createUserMessage('next')], 'final')
		expect(run.status).toBe('completed')
		return read.mock.calls.length
	} finally {
		read.mockRestore()
	}
}

describe('a host resending history it cached before a compaction pass', () => {
	it('is accepted, and the log reads do not grow with the messages edited', async () => {
		const reads: Record<number, number> = {}
		for (const k of [2, 8]) {
			const { log, cached } = await session(k)
			await edit(
				log,
				assistants(cached).map((m, i) => [m, `elided ${i}`] as [Message, string]),
			)
			reads[k] = await resendCounting(log, cached)
		}
		expect(reads[8]).toBe(reads[2])
	})

	it('accepts the text between two edits of the same message, and the original', async () => {
		const { log, cached } = await session(2)
		const [target] = assistants(cached) as [Message]
		await edit(log, [
			[target, 'first cut'],
			[target, 'second cut'],
		])
		for (const text of [target.content, 'first cut', 'second cut']) {
			const sent = cached.map((m) => (m.id === target.id ? withText(m, text) : m))
			const run = await query(log, [...sent, createUserMessage('next')], 'ok')
			expect(run.status).toBe('completed')
		}
	})

	it('refuses a text the id never carried', async () => {
		const { log, cached } = await session(2)
		const [target] = assistants(cached) as [Message]
		await edit(log, [[target, 'first cut']])
		const sent = cached.map((m) => (m.id === target.id ? withText(m, 'never said') : m))
		const refusal = await query(log, [...sent, createUserMessage('next')], 'no').catch(
			(error: unknown) => error,
		)
		expect(refusal).toMatchObject({
			code: 'stale_cached_history',
			details: { messageId: target.id, kind: 'edited' },
		})
	})

	it('refuses a text that predates a message_replaced', async () => {
		const { log, cached } = await session(2)
		const [target] = assistants(cached) as [Message]
		await edit(log, [[target, 'first cut']])
		await appendInTurn(log, [
			{
				type: 'message_replaced',
				targetMessageId: target.id,
				content: withText(target, 'guardrail answer'),
				reason: 'guardrail_rewritten',
			} as unknown as Draft,
		])
		for (const text of [target.content, 'first cut']) {
			const sent = cached.map((m) => (m.id === target.id ? withText(m, text) : m))
			const refusal = await query(log, [...sent, createUserMessage('next')], 'no').catch(
				(error: unknown) => error,
			)
			expect(refusal).toMatchObject({
				code: 'stale_cached_history',
				details: { messageId: target.id, kind: 'edited' },
			})
		}
	})
})
