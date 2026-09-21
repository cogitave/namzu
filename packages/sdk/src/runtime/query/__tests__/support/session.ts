/**
 * Test support for turns recorded into an in-memory session log.
 *
 * Not a test file (no `.test.ts`): suites import it to build a session, read
 * back its records and reach the checkpoint store the session keeps beside
 * its log.
 */
import {
	type SessionCheckpointStore,
	InMemorySessionCheckpointStore,
} from '../../../../store/checkpoint/index.js'
import {
	InMemorySessionLog,
	type SessionLease,
	type SessionLog,
} from '../../../../store/session-log/index.js'
import type { CheckpointScope } from '../../../../store/checkpoint/index.js'
import type {
	CheckpointId,
	MessageId,
	ProjectId,
	SessionId,
	TenantId,
	TopicId,
	TurnId,
} from '../../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../../types/message/index.js'
import {
	CHECKPOINT_DOCUMENT_VERSION,
	type Checkpoint,
} from '../../../../types/session/checkpoint.js'
import type { SessionEvent } from '../../../../types/session/events.js'
import type { SessionRecord } from '../../../../types/session/records.js'
import {
	generateCheckpointId,
	generateMessageId,
	generateSessionId,
	generateTurnId,
} from '../../../../utils/id.js'
import { checkpointLogView, resolveSessionStorage } from '../../session-storage.js'

/** Fixed attribution for a test session. */
export const TEST_SCOPE = {
	tenantId: '108babb0-2135-4a4a-87c4-a7f9a81dfaf7' as TenantId,
	projectId: 'a9382cd4-7476-42e1-bd76-7353d47a3907' as ProjectId,
	topicId: '26de5705-2f61-4c2a-8f64-39ff8f8587bb' as TopicId,
} as const

/** A fresh in-memory session: its id, its log, and the scope fields `query()` requires. */
export function memorySession(sessionId: SessionId = generateSessionId()) {
	const sessionLog = new InMemorySessionLog({ sessionId })
	return { ...TEST_SCOPE, sessionId, sessionLog }
}

/** Every record of a session log, oldest first. */
export async function records(log: SessionLog): Promise<SessionRecord[]> {
	return (await log.readAll()).entries.map((entry) => entry.record)
}

/** The record types of a session log, oldest first. */
export async function recordTypes(log: SessionLog): Promise<string[]> {
	return (await records(log)).map((record) => record.type)
}

/** The terminal records (`turn_completed`, `turn_failed`) of a session log, oldest first. */
export async function terminalRecords(
	log: SessionLog,
): Promise<Extract<SessionRecord, { type: 'turn_completed' | 'turn_failed' }>[]> {
	return (await records(log)).filter(
		(record): record is Extract<SessionRecord, { type: 'turn_completed' | 'turn_failed' }> =>
			record.type === 'turn_completed' || record.type === 'turn_failed',
	)
}

/** The live event types a listener received, in order. */
export function eventTypes(events: readonly SessionEvent[]): string[] {
	return events.map((event) => event.type)
}

/** The checkpoint store an in-memory session keeps beside its log (what `query()` uses by default). */
export async function heldCheckpointStore(
	log: InMemorySessionLog,
): Promise<SessionCheckpointStore> {
	return (await resolveSessionStorage({ sessionId: log.sessionId, sessionLog: log })).checkpoints
}

/**
 * The checkpoints one turn of an in-memory session wrote, oldest first, read
 * from the store `query()` kept beside the log.
 */
export async function turnCheckpoints(turn: {
	readonly sessionLog: InMemorySessionLog
	readonly tenantId: TenantId
	readonly projectId: ProjectId
	readonly sessionId: SessionId
	readonly turnId: TurnId
}): Promise<Checkpoint[]> {
	const store = await heldCheckpointStore(turn.sessionLog)
	return store.list({
		tenantId: turn.tenantId,
		projectId: turn.projectId,
		sessionId: turn.sessionId,
		turnId: turn.turnId,
	})
}

/** A fresh in-memory checkpoint store verified against `log`. */
export function checkpointStoreFor(log: SessionLog): InMemorySessionCheckpointStore {
	return new InMemorySessionCheckpointStore({ log: checkpointLogView(log) })
}

/** The checkpoint scope of one turn of a test session. */
export function turnScope(sessionId: SessionId, turnId: TurnId): CheckpointScope {
	return {
		tenantId: TEST_SCOPE.tenantId,
		projectId: TEST_SCOPE.projectId,
		sessionId,
		turnId,
	}
}

/** The turn ids a session log began, in order. */
export async function turnIds(log: SessionLog): Promise<TurnId[]> {
	return (await records(log))
		.filter((record) => record.type === 'turn_started')
		.map((record) => record.turnId as TurnId)
}

export { generateTurnId }

/** What {@link sessionWithCheckpoint} leaves behind. */
export interface CheckpointedSession {
	readonly sessionId: SessionId
	readonly turnId: TurnId
	readonly log: InMemorySessionLog
	readonly lease: SessionLease
	readonly store: InMemorySessionCheckpointStore
	readonly scope: CheckpointScope
	readonly checkpointId: CheckpointId
	/** Record ids of the recorded messages, in order. */
	readonly messageIds: readonly MessageId[]
}

/**
 * A session log holding one open turn with `messages` recorded, and one
 * committed checkpoint of it (document written, `checkpoint_written`
 * appended). `document` overrides fields of the checkpoint document.
 */
export async function sessionWithCheckpoint(
	options: {
		readonly messages?: readonly Message[]
		readonly document?: Partial<Checkpoint>
		/** Index into `messages` of the operator intent the checkpoint names. */
		readonly latestUserMessageIndex?: number
		readonly sessionId?: SessionId
		readonly turnId?: TurnId
		readonly checkpointId?: CheckpointId
		/**
		 * Give the writer lease up at the end, as a process that died would
		 * once it expired: the turn then reads as `interrupted`, and a resume
		 * in "another process" can take the session.
		 */
		readonly release?: boolean
	} = {},
): Promise<CheckpointedSession> {
	const sessionId = options.sessionId ?? generateSessionId()
	const turnId = options.turnId ?? generateTurnId()
	const log = new InMemorySessionLog({ sessionId })
	const lease = (await log.claim({ holder: 'test', ttlMs: 60_000 })) as SessionLease
	await log.append(lease, {
		type: 'session_started',
		projectId: TEST_SCOPE.projectId,
		tenantId: TEST_SCOPE.tenantId,
		topicId: TEST_SCOPE.topicId,
		cwd: '/tmp',
		agent: { id: 'agent', name: 'Agent' },
	})
	const messages = options.messages ?? [createUserMessage('do the work')]
	const messageIds = messages.map(() => generateMessageId())
	await log.beginTurn(lease, {
		turnId,
		userMessageId: messageIds[0] ?? generateMessageId(),
		config: { model: 'mock-model', tokenBudget: 0, timeoutMs: 0 },
	})
	let head = await log.head()
	for (const [index, message] of messages.entries()) {
		const entry = await log.append(lease, {
			type: 'message',
			turnId,
			messageId: messageIds[index] as MessageId,
			role: message.role,
			content: message,
		})
		head = { pointer: entry.pointer, gen: entry.record.gen, bytes: 0 }
	}
	const store = checkpointStoreFor(log)
	const scope = turnScope(sessionId, turnId)
	const intentId =
		options.latestUserMessageIndex === undefined
			? undefined
			: messageIds[options.latestUserMessageIndex]
	const document: Checkpoint = {
		v: CHECKPOINT_DOCUMENT_VERSION,
		kind: 'checkpoint',
		checkpointId: options.checkpointId ?? generateCheckpointId(),
		sessionId,
		turnId,
		iteration: 2,
		throughSeq: head?.pointer.seq ?? 1,
		throughSha256: head?.pointer.sha256 ?? '0'.repeat(64),
		tokenUsage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costInfo: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
		guards: { iteration: 2, elapsedMs: 500 },
		review: { structuredAttempts: 0, answerAttempts: 0, nativeStructuredAttempts: 0 },
		...(intentId ? { latestUserMessageId: intentId } : {}),
		turnCreatedAt: new Date(1_000).toISOString(),
		createdAt: new Date(1_500).toISOString(),
		...options.document,
	}
	const receipt = await store.write(scope, document)
	await log.append(lease, { type: 'checkpoint_written', turnId, ...receipt })
	if (options.release) await log.release(lease)
	return {
		sessionId,
		turnId,
		log,
		lease,
		store,
		scope,
		checkpointId: document.checkpointId,
		messageIds,
	}
}

/** The records side of a checkpoint manager, appending under the session's own lease. */
export function checkpointRecords(session: CheckpointedSession) {
	return {
		log: session.log,
		tenantId: TEST_SCOPE.tenantId,
		appendRecord: (draft: Parameters<SessionLog['append']>[1]) =>
			session.log.append(session.lease, draft),
		flush: async () => {},
	}
}
