/**
 * Test support: a queue of durable turns for `drainParkedTurns` — in-memory
 * session logs, each with one open turn and a committed checkpoint, and a
 * `SessionIndex` that lists them the way the real index would.
 *
 * Not a test file (no `.test.ts`): the drain suites import it.
 */
import {
	type CheckpointedSession,
	TEST_SCOPE,
	checkpointRecords,
	sessionWithCheckpoint,
} from '../../../runtime/query/__tests__/support/session.js'
import { CheckpointManager, readParks } from '../../../runtime/query/checkpoint.js'
import type { SessionIndex } from '../../../store/session-index/index.js'
import type { SessionLog } from '../../../store/session-log/index.js'
import type { HITLDecisionRequest } from '../../../types/hitl/index.js'
import type { SessionId } from '../../../types/ids/index.js'

export interface QueuedTurn {
	/** Parked on a tool review. */
	readonly parked?: boolean
	/** The park was answered. */
	readonly answered?: boolean
	/** Another worker still holds the session's lease. */
	readonly held?: boolean
}

export interface Queue {
	readonly sessions: readonly CheckpointedSession[]
	readonly index: SessionIndex
	readonly openLog: (sessionId: SessionId) => SessionLog
	/** Fields every drain pass needs. */
	readonly base: {
		readonly index: SessionIndex
		readonly openLog: (sessionId: SessionId) => SessionLog
		readonly tenantId: typeof TEST_SCOPE.tenantId
	}
}

/** Sessions as a queue of durable turns, and an index over them. */
export async function queue(turns: readonly QueuedTurn[]): Promise<Queue> {
	const sessions: CheckpointedSession[] = []
	for (const turn of turns) {
		const session = await sessionWithCheckpoint()
		if (turn.parked || turn.answered) {
			const manager = new CheckpointManager(
				checkpointRecords(session),
				session.store,
				session.scope,
			)
			const request = {
				type: 'tool_review',
				sessionId: session.sessionId,
				turnId: session.turnId,
				checkpointId: session.checkpointId,
				toolCalls: [{ id: 't1', name: 'deploy', input: {}, isDestructive: true }],
			} as unknown as HITLDecisionRequest
			await manager.park({ id: session.checkpointId }, request)
			if (turn.answered) await manager.unpark(session.checkpointId, { action: 'approve_tools' })
		}
		if (!turn.held) await session.log.release(session.lease)
		sessions.push(session)
	}
	const bySession = new Map(sessions.map((session) => [session.sessionId, session]))
	const row = (session: CheckpointedSession) => ({
		id: session.sessionId,
		slug: session.sessionId,
		projectId: TEST_SCOPE.projectId,
		rootId: session.sessionId,
		depth: 0,
		archived: false,
		status: 'running' as const,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
		logPath: `memory:${session.sessionId}`,
		logBytes: 0,
		headSeq: 0,
	})
	const index = {
		backend: 'scan',
		async getSession(sessionId: SessionId) {
			const session = bySession.get(sessionId)
			return session ? row(session) : undefined
		},
		async listSessions() {
			return sessions.map(row)
		},
		async listPendingDecisions(options: { sessionId?: SessionId } = {}) {
			const decisions = []
			for (const session of sessions) {
				if (options.sessionId && session.sessionId !== options.sessionId) continue
				for (const park of await readParks(session.log)) {
					if (park.pending.resolvedAt !== undefined) continue
					decisions.push({
						decisionId: park.decisionId,
						sessionId: session.sessionId,
						turnId: park.turnId,
						checkpointId: park.checkpointId,
					})
				}
			}
			return decisions
		},
	} as unknown as SessionIndex
	const openLog = (sessionId: SessionId): SessionLog => {
		const session = bySession.get(sessionId)
		if (!session) throw new Error(`no session ${sessionId}`)
		return session.log
	}
	return { sessions, index, openLog, base: { index, openLog, tenantId: TEST_SCOPE.tenantId } }
}
