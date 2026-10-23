import { describe, expect, it } from 'vitest'
import { SessionQuery } from '../../../session-query/index.js'
import type { ProjectId, TenantId, TopicId } from '../../../types/ids/index.js'
import {
	type Message,
	createAssistantMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import { generateMessageId, generateSessionId, generateTurnId } from '../../../utils/id.js'
import { InMemorySessionLog, type SessionLease, type SessionLog } from '../index.js'

type Draft = Parameters<SessionLog['append']>[1]

/**
 * A `context-rewrite` re-base keeps its summary small, but nothing in the log
 * enforced that: a large summary was written inline under the 4 MiB record cap
 * and bloated the file (and made replay heavy). A compaction-specific spill
 * threshold now writes a large summary beside the log instead, and the fold
 * reads it back transparently — so the on-disk record stays tiny and the model
 * sees the same conversation either way.
 */
async function buildLog(compactionSpillAboveBytes: number, summary: Message[]) {
	const sessionId = generateSessionId()
	const log = new InMemorySessionLog({ sessionId, compactionSpillAboveBytes })
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
	await log.append(lease, {
		turnId,
		type: 'compaction',
		compactionId: generateMessageId(),
		strategy: 'context-rewrite',
		trigger: 'auto',
		replacesSeqRange: [1, 2],
		summary,
		keptMessageIds: [],
		tokensBefore: 0,
		tokensAfter: 0,
	} as Draft)
	const keptId = generateMessageId()
	const kept = createAssistantMessage('the surviving reply')
	await log.append(lease, {
		turnId,
		type: 'message',
		messageId: keptId,
		role: kept.role,
		content: kept,
	} as Draft)
	return { log, sessionId }
}

async function compactionRecordSummary(log: InMemorySessionLog): Promise<unknown> {
	for await (const entry of log.read()) {
		const record = entry.record as { type: string; summary?: unknown }
		if (record.type === 'compaction') return record.summary
	}
	return undefined
}

describe('a large compaction summary spills', () => {
	it('spills a summary over the bound yet folds back to the same conversation', async () => {
		// A summary well over a tiny bound, but well under the 4 MiB record cap
		// that used to be the only gate — exactly the size that bloated the log.
		const summary: Message[] = Array.from({ length: 40 }, (_, i) =>
			createUserMessage(`summarised turn ${i}: ${'x'.repeat(400)}`),
		)

		const spilled = await buildLog(64, summary)
		const inline = await buildLog(8 * 1024 * 1024, summary)

		// The spilled log wrote the summary out of line: the record names a spill,
		// not an array.
		const spilledSummary = await compactionRecordSummary(spilled.log)
		expect(Array.isArray(spilledSummary)).toBe(false)
		expect(spilledSummary).toMatchObject({ path: expect.any(String), sha256: expect.any(String) })

		// The inline log kept the array.
		expect(Array.isArray(await compactionRecordSummary(inline.log))).toBe(true)

		// The on-disk line for the spilled compaction is tiny; the inline one is not.
		const sizeOf = async (log: InMemorySessionLog) => log.medium.size()
		expect(await sizeOf(spilled.log)).toBeLessThan(await sizeOf(inline.log))

		// Both fold back to the identical conversation — spill is transparent.
		const spilledTranscript = await new SessionQuery({ log: spilled.log }).fullTranscript()
		const inlineTranscript = await new SessionQuery({ log: inline.log }).fullTranscript()
		expect(spilledTranscript.map((m) => m.content)).toEqual(inlineTranscript.map((m) => m.content))
		expect(spilledTranscript.map((m) => m.content)).toEqual([
			...summary.map((m) => m.content),
			'the surviving reply',
		])
	})
})
