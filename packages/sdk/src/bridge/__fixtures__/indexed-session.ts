import type { SessionIndex } from '../../store/session-index/index.js'
import { InMemorySessionLog } from '../../store/session-log/memory.js'
import type { SessionId } from '../../types/ids/index.js'
import type { Origin } from '../../types/session/turn.js'
import { generateMessageId, generateProjectId, generateTurnId } from '../../utils/id.js'

/**
 * Start a session the way a protocol host does after resolving a caller's id
 * to "a new session": `session_started` and the first `turn_started`, both
 * carrying `origin`, appended to a real in-memory log and then indexed.
 *
 * Nothing here writes an external ref. The index derives it from the records,
 * which is the only way a ref ever exists (spec D9), so a test that resolves
 * the same caller id afterwards proves the round trip rather than a stub.
 */
export async function startIndexedSession(
	index: Pick<SessionIndex, 'indexSession'>,
	sessionId: SessionId,
	origin: Origin,
): Promise<InMemorySessionLog> {
	const log = new InMemorySessionLog({ sessionId })
	const lease = await log.claim({ holder: 'protocol-host', ttlMs: 60_000 })
	if (lease === null) throw new Error('a fresh in-memory log refused its first lease')
	await log.append(lease, {
		type: 'session_started',
		projectId: generateProjectId(),
		cwd: '/workspace',
		agent: { id: 'agent', name: 'Agent' },
		origin,
	})
	await log.beginTurn(lease, {
		turnId: generateTurnId(),
		userMessageId: generateMessageId(),
		config: { model: 'model', tokenBudget: 1_000, timeoutMs: 60_000 },
		origin,
	})
	await index.indexSession({
		slug: 'workspace',
		logPath: `/memory/${sessionId}.jsonl`,
		records: log.read(),
	})
	return log
}
