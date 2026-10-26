import { describe, expect, it } from 'vitest'
import { findPendingCheckpoint } from '../../../runtime/query/checkpoint.js'
import type { ProjectId, TenantId, TopicId } from '../../../types/ids/index.js'
import { SESSION_RECORD_MAX_BYTES } from '../../../types/session/records.js'
import {
	generateCheckpointId,
	generateMessageId,
	generateSessionId,
	generateTurnId,
} from '../../../utils/id.js'
import { InMemorySessionLog, type SessionLease, type SessionLog } from '../index.js'

type Draft = Parameters<SessionLog['append']>[1]

/**
 * A batch of large writes used to make one record bigger than a line may be,
 * which ended the turn before the person was asked. Large inputs now sit in
 * `tool-results/` and the record keeps a stand-in; a resumed turn reads the
 * calls back whole.
 */
async function openTurn() {
	const sessionId = generateSessionId()
	const log = new InMemorySessionLog({ sessionId })
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
	return { log, lease, turnId }
}

const calls = (count: number, size: number) =>
	Array.from({ length: count }, (_, i) => ({
		id: `call_${i}`,
		name: 'write',
		input: { path: `f${i}.txt`, content: String.fromCharCode(97 + (i % 26)).repeat(size) },
		isDestructive: true,
	}))

async function recordsOfType(log: InMemorySessionLog, type: string) {
	const found: Record<string, unknown>[] = []
	for await (const entry of log.read()) {
		if ((entry.record as { type: string }).type === type)
			found.push(entry.record as unknown as Record<string, unknown>)
	}
	return found
}

describe('a large tool input spills', () => {
	it('writes a review of many large writes instead of failing the turn', async () => {
		const { log, lease, turnId } = await openTurn()
		await log.append(lease, {
			turnId,
			type: 'tool_review_requested',
			toolCalls: calls(30, 150_000),
			iteration: 1,
		} as unknown as Draft)
		const [record] = await recordsOfType(log, 'tool_review_requested')
		expect(JSON.stringify(record).length).toBeLessThan(SESSION_RECORD_MAX_BYTES)
		const inputs = (record?.toolCalls as { input: Record<string, unknown> }[]).map((c) => c.input)
		expect(inputs.some((input) => '$spilledInput' in input)).toBe(true)
	})

	it('spills a single huge write and keeps small inputs inline', async () => {
		const { log, lease, turnId } = await openTurn()
		await log.append(lease, {
			turnId,
			type: 'tool_executing',
			toolUseId: 'call_0',
			toolName: 'write',
			input: { path: 'huge.txt', content: 'x'.repeat(SESSION_RECORD_MAX_BYTES + 10) },
		} as unknown as Draft)
		await log.append(lease, {
			turnId,
			type: 'tool_executing',
			toolUseId: 'call_1',
			toolName: 'write',
			input: { path: 'small.txt', content: 'hi' },
		} as unknown as Draft)
		const [huge, small] = await recordsOfType(log, 'tool_executing')
		expect(huge?.input).toHaveProperty('$spilledInput')
		expect(small?.input).toEqual({ path: 'small.txt', content: 'hi' })
	})

	it('restores every call of a spilled review when the turn is resumed', async () => {
		const { log, lease, turnId } = await openTurn()
		const checkpointId = generateCheckpointId()
		const toolCalls = calls(30, 150_000)
		await log.append(lease, {
			turnId,
			type: 'decision_requested',
			decisionId: checkpointId,
			checkpointId,
			request: { type: 'tool_review', checkpointId, turnId, sessionId: log.sessionId, toolCalls },
		} as unknown as Draft)
		const parks = await recordsOfType(log, 'decision_requested')
		const stored = (parks[0]?.request as { toolCalls: { input: object }[] }).toolCalls
		expect(stored.some((call) => '$spilledInput' in call.input)).toBe(true)
		const park = await findPendingCheckpoint(log, { turnId })
		const restored = (park?.pending.request as unknown as { toolCalls: typeof toolCalls }).toolCalls
		expect(restored).toEqual(toolCalls)
	})
})
