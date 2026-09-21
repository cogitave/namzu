import { describe, expect, it, vi } from 'vitest'

import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { EventTranslator } from '../../../runtime/query/events.js'
import { InMemorySessionLog, type SessionLog } from '../../../store/session-log/index.js'
import type { SessionId, ToolUseId, TurnId } from '../../../types/ids/index.js'
import type { SessionEvent } from '../../../types/session/events.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { generateMessageId, generateSessionId, generateTurnId } from '../../../utils/id.js'
import { childSessionEnded } from '../../agent/child-session.js'
import { TurnRecorder } from '../turn-recorder.js'

/**
 * A parent turn records the children it delegates to in its own session log.
 *
 * The index lists a session's children, and the CLI replays finished ones,
 * from the parent's `child_session_spawned` and `child_session_ended`
 * records. Nothing wrote them: the manager announced each child to a
 * listener, and the parent's log never heard. The recorder now appends the
 * spawn inside the turn that spawned the child, and on the child's idle the
 * ended record read from the child's own terminal record, so the two cannot
 * disagree.
 */

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}

const SESSION = '1b9fa4ed-2300-43ac-9ee1-c641c9ae66d1' as SessionId
const SCOPE = {
	sessionId: SESSION,
	topicId: '07c17470-7e89-4c5e-9680-2d10d92ac22a',
	projectId: '4dfa889d-312b-4570-a8e3-e1ccd3f2274b',
	tenantId: '2c8e25c0-8fc7-4427-8e9e-f338d6e51c02',
}

async function begunTurn(sessionLog: SessionLog) {
	const recorder = new TurnRecorder({
		turnId: generateTurnId(),
		agentId: 'parent',
		agentName: 'Parent',
		turnConfig: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
		providerId: 'mock',
		log: LOG,
		...SCOPE,
		sessionLog,
	} as never)
	await recorder.open({ session: { cwd: '/tmp' } })
	const emitter = new EventTranslator(recorder)
	await emitter.beginTurn({})
	recorder.markRunning()
	;[...emitter.drainPending()]
	return recorder
}

/** A child log holding one settled turn, as the child's own recorder leaves it. */
async function settledChild(childId: SessionId): Promise<SessionLog> {
	const log = new InMemorySessionLog({ sessionId: childId })
	const lease = await log.claim({ holder: 'child', ttlMs: 60_000 })
	if (!lease) throw new Error('claim failed')
	const turnId = generateTurnId()
	await log.append(lease, {
		type: 'session_started',
		projectId: SCOPE.projectId,
		cwd: '/tmp',
		agent: { id: 'worker', name: 'Worker' },
	} as never)
	await log.beginTurn(lease, {
		turnId,
		userMessageId: generateMessageId(),
		config: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
	})
	await log.append(lease, {
		type: 'turn_completed',
		turnId,
		result: 'done',
		stopReason: 'end_turn',
		settlement: {
			status: 'completed',
			iterations: 1,
			usage: { ...EMPTY_TOKEN_USAGE, totalTokens: 7, completionTokens: 7 },
			cost: { ...ZERO_COST },
			durationMs: 1,
			resultSource: 'model',
			abandonedTaskIds: [],
			abandonedJobIds: [],
		},
	} as never)
	await log.release(lease)
	return log
}

function spawned(childId: SessionId, turnId: TurnId, sessionId: SessionId = SESSION) {
	return {
		type: 'child_session_spawned',
		sessionId,
		turnId,
		childSessionId: childId,
		toolCallId: 'call_1' as ToolUseId,
		kind: 'agent_spawn',
		description: 'inspect',
		path: `subagents/${childId}.jsonl`,
		batch: { batchId: 'review', name: 'review', phase: 'read' },
	} as Extract<SessionEvent, { type: 'child_session_spawned' }>
}

describe('a parent turn records its children', () => {
	it('appends the spawn inside the turn, then the idle and the ended record the child settled with', async () => {
		const parentLog = new InMemorySessionLog({ sessionId: SESSION })
		const recorder = await begunTurn(parentLog)
		const childId = generateSessionId()
		const childLog = await settledChild(childId)

		await recorder.recordChildSessionEvent(spawned(childId, recorder.turnId))
		await recorder.recordChildSessionEvent(
			{
				type: 'child_session_idled',
				sessionId: SESSION,
				turnId: recorder.turnId,
				childSessionId: childId,
			},
			childLog,
		)
		await recorder.flush()

		const records = (await parentLog.readAll()).entries.map((entry) => entry.record)
		const tail = records.slice(-3)
		expect(tail.map((record) => record.type)).toEqual([
			'child_session_spawned',
			'child_session_idled',
			'child_session_ended',
		])
		expect(tail[0]).toMatchObject({
			turnId: recorder.turnId,
			childSessionId: childId,
			batch: { batchId: 'review', name: 'review', phase: 'read' },
		})
		const ended = await childSessionEnded(childLog)
		expect(tail[2]).toMatchObject({ ...ended, turnId: recorder.turnId })
	})

	it("leaves another session's children out of this log", async () => {
		const parentLog = new InMemorySessionLog({ sessionId: SESSION })
		const recorder = await begunTurn(parentLog)
		const before = (await parentLog.readAll()).entries.length

		const recorded = await recorder.recordChildSessionEvent(
			spawned(generateSessionId(), recorder.turnId, generateSessionId()),
		)

		expect(recorded).toBeUndefined()
		expect((await parentLog.readAll()).entries).toHaveLength(before)
	})

	it('writes no ended record for a child whose log it cannot reach', async () => {
		const parentLog = new InMemorySessionLog({ sessionId: SESSION })
		const recorder = await begunTurn(parentLog)
		const childId = generateSessionId()

		await recorder.recordChildSessionEvent({
			type: 'child_session_idled',
			sessionId: SESSION,
			turnId: recorder.turnId,
			childSessionId: childId,
		})
		await recorder.flush()

		const types = (await parentLog.readAll()).entries.map((entry) => entry.record.type)
		expect(types.at(-1)).toBe('child_session_idled')
		expect(types).not.toContain('child_session_ended')
	})
})
