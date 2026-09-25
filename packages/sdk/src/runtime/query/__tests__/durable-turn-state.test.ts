import { describe, expect, it, vi } from 'vitest'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import type { CheckpointId, HITLDecisionRequest } from '../../../types/hitl/index.js'
import type { TurnId } from '../../../types/ids/index.js'
import {
	TURN_STATE_VERSION,
	TurnStateVersionError,
	parseTurnState,
} from '../../../types/session/turn-state.js'
import {
	InvalidIdError,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { CheckpointManager, findPendingCheckpoint, readParks } from '../checkpoint.js'
import { type TurnStateScope, loadSelectedTurnState, loadTurnState } from '../turn-state.js'
import {
	type CheckpointedSession,
	TEST_SCOPE,
	addCheckpoint,
	checkpointRecords,
	checkpointStoreFor,
	sessionWithCheckpoint,
} from './support/session.js'

/**
 * A parked approval used to exist only as a suspended `await` inside one
 * process. Nothing durable said a human owed the turn an answer, so an
 * approval queue could not be rebuilt and a serverless host could not park
 * a turn at all — the container that held the promise had to stay alive.
 * The park is a `decision_requested` record in the session log now.
 */

const TURN_ID = '54bf5651-0b7b-443e-a3c6-05170fe66108' as TurnId

function usage(iteration: number) {
	return {
		promptTokens: 10 * iteration,
		completionTokens: iteration,
		totalTokens: 11 * iteration,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
}

/** A session whose turn committed a checkpoint at iteration 1. */
function session(): Promise<CheckpointedSession> {
	return sessionWithCheckpoint({
		turnId: TURN_ID,
		document: { iteration: 1, tokenUsage: usage(1), guards: { iteration: 1, elapsedMs: 1_000 } },
	})
}

function scopeOf(s: CheckpointedSession): TurnStateScope {
	return { ...TEST_SCOPE, sessionId: s.sessionId, turnId: s.turnId }
}

function manager(s: CheckpointedSession): CheckpointManager {
	return new CheckpointManager(checkpointRecords(s), s.store, s.scope)
}

const reviewRequest = (s: CheckpointedSession, checkpointId: CheckpointId): HITLDecisionRequest =>
	({
		type: 'tool_review',
		sessionId: s.sessionId,
		turnId: s.turnId,
		checkpointId,
		toolCalls: [{ id: 'call_1', name: 'delete_row', input: { id: 42 }, isDestructive: true }],
	}) as HITLDecisionRequest

describe('recording a park', () => {
	it('makes the outstanding decision readable from the log alone', async () => {
		const s = await session()
		expect(await findPendingCheckpoint(s.log, { turnId: s.turnId })).toBeNull()

		await manager(s).park({ id: s.checkpointId }, reviewRequest(s, s.checkpointId))

		// A DIFFERENT reader — another log instance over the same bytes, i.e.
		// what a second process has.
		const fresh = new InMemorySessionLog({ sessionId: s.sessionId, medium: s.log.medium })
		const found = await findPendingCheckpoint(fresh, { turnId: s.turnId })
		expect(found?.checkpointId).toBe(s.checkpointId)
		expect(found?.pending.request.type).toBe('tool_review')
		expect(found?.pending.parkedAt).toBeGreaterThan(0)
	})

	it('stops being outstanding once answered, and keeps the answer as evidence', async () => {
		const s = await session()
		const mgr = manager(s)
		await mgr.park({ id: s.checkpointId }, reviewRequest(s, s.checkpointId))

		await mgr.unpark(s.checkpointId, { action: 'approve_tools' })

		expect(await findPendingCheckpoint(s.log, { turnId: s.turnId })).toBeNull()
		const [answered] = await readParks(s.log, { turnId: s.turnId })
		// Not erased — a gate that cannot say what was approved is not an
		// audit trail.
		expect(answered?.pending.decision).toEqual({ action: 'approve_tools' })
		expect(answered?.pending.resolvedAt).toBeGreaterThan(0)
	})

	it('returns the newest outstanding park when several checkpoints exist', async () => {
		const s = await session()
		await addCheckpoint(s)
		const third = await addCheckpoint(s)
		const mgr = manager(s)
		await mgr.park({ id: s.checkpointId }, reviewRequest(s, s.checkpointId))
		await mgr.unpark(s.checkpointId, { action: 'approve_tools' })
		await mgr.park({ id: third }, reviewRequest(s, third))

		expect((await findPendingCheckpoint(s.log, { turnId: s.turnId }))?.checkpointId).toBe(third)
	})

	it('unparking something that was never parked is a no-op, not a crash', async () => {
		const s = await session()
		const mgr = manager(s)
		expect(await mgr.unpark(s.checkpointId, { action: 'approve_tools' })).toBeNull()
		expect(
			await mgr.unpark('7c81157d-b597-49f9-b951-772a567ecdf2' as CheckpointId, {
				action: 'approve_tools',
			}),
		).toBeNull()
	})
})

describe('loadTurnState', () => {
	it.each(['projectId', 'tenantId', 'topicId', 'sessionId'] as const)(
		'refuses a foreign %s before reading checkpoints or session history',
		async (field) => {
			const s = await session()
			const scope = {
				...scopeOf(s),
				[field]: {
					projectId: generateProjectId,
					tenantId: generateTenantId,
					topicId: generateTopicId,
					sessionId: generateSessionId,
				}[field](),
			} as TurnStateScope
			const list = vi.spyOn(s.store, 'list')
			const restore = vi.spyOn(s.store, 'restore')
			const readHistory = vi.spyOn(s.log, 'read')

			await expect(loadTurnState(s.log, s.store, scope)).rejects.toMatchObject({
				code: 'invalid_config',
				details: { fields: [field] },
			})
			await expect(
				loadSelectedTurnState(s.log, s.store, scope, s.checkpointId),
			).rejects.toMatchObject({
				code: 'invalid_config',
				details: { fields: [field] },
			})
			expect(list).not.toHaveBeenCalled()
			expect(restore).not.toHaveBeenCalled()
			// The owner check reads only the opening record, not the conversation.
			expect(readHistory.mock.calls.every(([options]) => options?.throughSeq === 1)).toBe(true)
		},
	)
	it.each(['tenantId', 'topicId'] as const)(
		'refuses a legacy session missing %s before reading checkpoints',
		async (field) => {
			const log = new InMemorySessionLog({ sessionId: generateSessionId() })
			const lease = await log.claim({ holder: 'test', ttlMs: 60_000 })
			expect(lease).not.toBeNull()
			await log.append(lease!, {
				type: 'session_started',
				projectId: TEST_SCOPE.projectId,
				...(field === 'tenantId' ? {} : { tenantId: TEST_SCOPE.tenantId }),
				...(field === 'topicId' ? {} : { topicId: TEST_SCOPE.topicId }),
				cwd: '/tmp',
				agent: { id: 'agent', name: 'Agent' },
			})
			const store = checkpointStoreFor(log)
			const list = vi.spyOn(store, 'list')
			const restore = vi.spyOn(store, 'restore')
			await expect(
				loadTurnState(log, store, { ...TEST_SCOPE, sessionId: log.sessionId, turnId: TURN_ID }),
			).rejects.toMatchObject({ code: 'invalid_config', details: { fields: [field] } })
			expect(list).not.toHaveBeenCalled()
			expect(restore).not.toHaveBeenCalled()
		},
	)

	it('rebuilds a snapshot with no live turn object', async () => {
		const s = await session()
		const second = await addCheckpoint(s, {
			iteration: 2,
			tokenUsage: usage(2),
			guards: { iteration: 2, elapsedMs: 2_000 },
		})

		const state = await loadTurnState(s.log, s.store, scopeOf(s))

		expect(state).not.toBeNull()
		expect(state?.turnId).toBe(TURN_ID)
		expect(state?.currentIteration).toBe(2)
		// Budgets are properties of the TURN, not of the process hosting it.
		expect(state?.elapsedMs).toBe(2_000)
		expect(state?.tokenUsage.totalTokens).toBe(22)
		expect(state?.checkpointId).toBe(second)
	})

	it('prefers the outstanding park over the newest checkpoint', async () => {
		// "What is this turn waiting on" is the question a resuming process
		// is actually asking.
		const s = await session()
		await addCheckpoint(s, { iteration: 2, guards: { iteration: 2, elapsedMs: 2_000 } })
		await manager(s).park({ id: s.checkpointId }, reviewRequest(s, s.checkpointId))

		const state = await loadTurnState(s.log, s.store, scopeOf(s))
		expect(state?.checkpointId).toBe(s.checkpointId)
		expect(state?.pending?.request.type).toBe('tool_review')
	})

	it('returns null for a turn that never checkpointed', async () => {
		// Rather than synthesizing a snapshot that would restart from zero
		// while claiming to be a continuation.
		const log = new InMemorySessionLog({ sessionId: generateSessionId() })
		const scope = { ...TEST_SCOPE, sessionId: log.sessionId, turnId: TURN_ID }
		const store = checkpointStoreFor(log)
		const list = vi.spyOn(store, 'list')
		expect(await loadTurnState(log, store, scope)).toBeNull()
		expect(list).not.toHaveBeenCalled()
	})

	it('survives a JSON round trip', async () => {
		const s = await session()
		const state = await loadTurnState(s.log, s.store, scopeOf(s))
		const revived = parseTurnState(JSON.stringify(state))
		expect(revived).toEqual(state)
	})
})

describe('parseTurnState', () => {
	it('refuses a snapshot from an incompatible version', () => {
		// A silent partial restore produces a turn that looks healthy and has
		// lost its budgets.
		expect(() => parseTurnState(JSON.stringify({ version: 99, turnId: TURN_ID }))).toThrow(
			TurnStateVersionError,
		)
	})

	it('refuses a snapshot with no version at all', () => {
		expect(() => parseTurnState('{"turnId":"f4e0af37-43f7-48fd-82b0-f1b1c68881d3"}')).toThrow(
			TurnStateVersionError,
		)
		expect(() => parseTurnState('null')).toThrow(TurnStateVersionError)
	})

	it('accepts an object as well as a string', () => {
		const state = { version: TURN_STATE_VERSION, turnId: TURN_ID }
		expect(parseTurnState(state).turnId).toBe(TURN_ID)
	})

	it.each([1, 2, 3, 4])('refuses a RunState of version %s, naming it', (version) => {
		// The turn model is gone and there is no migration: a snapshot that
		// carries `runId` is one the previous major has to resolve.
		expect(() => parseTurnState({ version, runId: TURN_ID })).toThrow(/RunState/)
	})

	it.each([
		['turnId', 'run_old'],
		['parentTurnId', 'run_parent'],
		['parentSessionId', 'ses_parent'],
		['sessionId', 'ses_old'],
		['projectId', 'prj_old'],
		['tenantId', 'tnt_old'],
		['topicId', 'top_old'],
		['checkpointId', 'cp_old'],
	])('refuses a prefixed %s without rewriting its recorded value', (field, value) => {
		const raw = { version: TURN_STATE_VERSION, [field]: value }
		expect(() => parseTurnState(raw)).toThrow(InvalidIdError)
		expect(raw[field]).toBe(value)
	})

	it.each(['030c4c5d-1987-40b7-b197-bb1860fab281', '5985bc78-64b1-438b-972f-96d5dc0c5af0'])(
		'preserves topic ID %s through a snapshot read',
		(topicId) => {
			const current = { version: TURN_STATE_VERSION, turnId: TURN_ID, topicId }
			expect(parseTurnState(JSON.stringify(current))).toEqual(current)
		},
	)
})
