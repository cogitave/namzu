import { describe, expect, it } from 'vitest'

import { findPendingCheckpoint } from '../../../runtime/query/checkpoint.js'
import {
	InMemorySessionLog,
	type SessionLease,
	type SessionLog,
} from '../../../store/session-log/index.js'
import type { ProjectId, TenantId, TopicId } from '../../../types/ids/index.js'
import { SESSION_RECORD_MAX_BYTES } from '../../../types/session/records.js'
import {
	generateCheckpointId,
	generateMessageId,
	generateSessionId,
	generateTurnId,
} from '../../../utils/id.js'
import { eventDraft } from '../turn-recorder.js'

type Draft = Parameters<SessionLog['append']>[1]

async function openTurn() {
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
	return { log, lease, turnId }
}

const call = (id: string, input: unknown) => ({ id, name: 'write', input, isDestructive: true })

async function recordsOfType(log: InMemorySessionLog, type: string) {
	const found: Record<string, unknown>[] = []
	for await (const entry of log.read()) {
		if ((entry.record as { type: string }).type === type)
			found.push(entry.record as unknown as Record<string, unknown>)
	}
	return found
}

describe('a large tool input goes through the recorder whole and is kept by the spill', () => {
	it('keeps a 30 x 150k review batch whole in the draft and restores it whole on resume', async () => {
		const { log, lease, turnId } = await openTurn()
		const toolCalls = Array.from({ length: 30 }, (_, i) =>
			call(`c${i}`, { path: `f${i}`, content: 'A'.repeat(150_000) }),
		)
		const draft = eventDraft(
			{
				type: 'tool_review_requested',
				sessionId: log.sessionId,
				turnId,
				toolCalls,
				iteration: 1,
			} as never,
			undefined,
		) as unknown as { toolCalls: typeof toolCalls }
		expect(draft.toolCalls).toEqual(toolCalls)

		const checkpointId = generateCheckpointId()
		await log.append(lease, {
			turnId,
			type: 'decision_requested',
			decisionId: checkpointId,
			checkpointId,
			request: {
				type: 'tool_review',
				checkpointId,
				turnId,
				sessionId: log.sessionId,
				toolCalls: draft.toolCalls,
			},
		} as unknown as Draft)
		const [parked] = await recordsOfType(log, 'decision_requested')
		expect(JSON.stringify(parked).length).toBeLessThan(SESSION_RECORD_MAX_BYTES)
		const park = await findPendingCheckpoint(log, { turnId })
		const restored = (park?.pending.request as unknown as { toolCalls: typeof toolCalls }).toolCalls
		expect(restored).toEqual(toolCalls)
	})

	it('keeps a single 4.5 MB input whole in the draft and spills it from the record', async () => {
		const { log, lease, turnId } = await openTurn()
		const input = { path: 'big', content: 'A'.repeat(4_500_000) }
		for (const type of ['tool_input_completed', 'tool_executing']) {
			const draft = eventDraft(
				{
					type,
					sessionId: log.sessionId,
					turnId,
					toolUseId: 'tu_1',
					toolName: 'write',
					name: 'write',
					input,
				} as never,
				undefined,
			) as unknown as { input: unknown }
			expect(draft.input).toEqual(input)
			await log.append(lease, { ...draft, turnId, type } as unknown as Draft)
		}
		for (const type of ['tool_input_completed', 'tool_executing']) {
			const [record] = await recordsOfType(log, type)
			expect(JSON.stringify(record).length).toBeLessThan(SESSION_RECORD_MAX_BYTES)
			expect(record?.input).toHaveProperty('$spilledInput')
		}
	})
})
