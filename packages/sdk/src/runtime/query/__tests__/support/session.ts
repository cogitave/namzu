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
import type { SessionTokenBudgetScope } from '../../../../store/budget/index.js'
import {
	InMemoryLogMedium,
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
import {
	checkpointLogView,
	heldSessionState,
	resolveSessionStorage,
} from '../../session-storage.js'

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

/**
 * A second copy of an in-memory session, as a restore from a backup would
 * produce: the log's bytes, the checkpoints of `turns`, the ledgers those
 * checkpoints are bound to, and the ledgers of `budgets`. The copy then
 * diverges from the original.
 */
export async function copySession(
	source: InMemorySessionLog,
	turns: readonly CheckpointScope[],
	budgets: readonly SessionTokenBudgetScope[] = [],
): Promise<InMemorySessionLog> {
	const medium = new InMemoryLogMedium()
	const size = await source.medium.size()
	await medium.append(await source.medium.read(0, size), 0)
	const copy = new InMemorySessionLog({
		sessionId: source.sessionId,
		medium,
		leases: source.leaseStore,
		spills: source.spillStore,
	})
	const from = heldSessionState(source)
	const to = await resolveSessionStorage({ sessionId: source.sessionId, sessionLog: copy })
	if (!from) return copy
	const ledgers = new Map(
		budgets.map((scope) => [`${scope.rootSessionId}/${scope.rootTurnId}`, scope]),
	)
	for (const scope of turns) {
		for (const checkpoint of await from.checkpoints.list(scope)) {
			await to.checkpoints.write(scope, JSON.parse(JSON.stringify(checkpoint)) as Checkpoint)
			const binding = checkpoint.budget?.binding
			if (binding) {
				ledgers.set(`${binding.rootSessionId}/${binding.rootTurnId}`, {
					rootSessionId: binding.rootSessionId,
					rootTurnId: binding.rootTurnId,
				})
			}
		}
	}
	for (const scope of ledgers.values()) {
		const ledger = await from.tokenBudgets.load(scope)
		if (ledger) await to.tokenBudget.save(scope, JSON.parse(JSON.stringify(ledger)))
	}
	return copy
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

/**
 * Commit one more checkpoint of the session's open turn, at the log's head,
 * under the session's own lease. `document` overrides fields of it.
 */
export async function addCheckpoint(
	session: CheckpointedSession,
	document: Partial<Checkpoint> = {},
): Promise<CheckpointId> {
	const head = await session.log.head()
	const previous = await session.store.read(session.scope, session.checkpointId)
	if (!previous || !head) throw new Error('addCheckpoint needs the session’s first checkpoint')
	const next: Checkpoint = {
		...previous,
		checkpointId: generateCheckpointId(),
		iteration: previous.iteration + 1,
		throughSeq: head.pointer.seq,
		throughSha256: head.pointer.sha256,
		createdAt: new Date(Date.parse(previous.createdAt) + 1_000).toISOString(),
		...document,
	}
	const receipt = await session.store.write(session.scope, next)
	await session.log.append(session.lease, {
		type: 'checkpoint_written',
		turnId: session.turnId,
		...receipt,
	})
	return next.checkpointId
}

/** A record without its envelope: what a writer appends. */
export type RecordDraft = Parameters<SessionLog['append']>[1]

/**
 * A new in-memory session whose log is `source`'s, record by record, with
 * `transform` applied to each record's payload — the way a test stands in
 * for "the log said something else". Checkpoints of `turns` are carried
 * over, re-anchored to the new log's hashes, together with the ledgers they
 * are bound to. The source is only read.
 */
export async function rewriteSession(
	source: InMemorySessionLog,
	turns: readonly CheckpointScope[],
	transform: (draft: RecordDraft) => RecordDraft = (draft) => draft,
): Promise<InMemorySessionLog> {
	// Spilled bodies are shared, so a record that names one still finds it.
	const target = new InMemorySessionLog({
		sessionId: source.sessionId,
		spills: source.spillStore,
	})
	const storage = await resolveSessionStorage({ sessionId: source.sessionId, sessionLog: target })
	const from = heldSessionState(source)
	const lease = (await target.claim({ holder: 'rewrite', ttlMs: 60_000 })) as SessionLease
	const hashes = new Map<number, string>()
	const ledgers = new Map<string, SessionTokenBudgetScope>()
	for (const record of await records(source)) {
		const {
			v: _v,
			id: _id,
			sessionId: _sessionId,
			seq: _seq,
			ts: _ts,
			prev: _prev,
			prevText: _prevText,
			gen: _gen,
			...payload
		} = record as SessionRecord & { prevText?: unknown }
		const draft = transform(payload as RecordDraft)
		let entry: Awaited<ReturnType<SessionLog['append']>>
		if (draft.type === 'turn_started') {
			const { type: _type, ...turn } = draft
			entry = await target.beginTurn(lease, turn as Parameters<SessionLog['beginTurn']>[1])
		} else if (draft.type === 'checkpoint_written') {
			const written = draft as RecordDraft & { checkpointId: CheckpointId; turnId: TurnId }
			const scope = turns.find((candidate) => candidate.turnId === written.turnId)
			const document = scope ? await from?.checkpoints.read(scope, written.checkpointId) : null
			if (!scope || !document)
				throw new Error(`No checkpoint ${written.checkpointId} to carry over`)
			const anchored: Checkpoint = {
				...document,
				throughSha256: hashes.get(document.throughSeq) ?? document.throughSha256,
			}
			const receipt = await storage.checkpoints.write(scope, anchored)
			entry = await target.append(lease, {
				type: 'checkpoint_written',
				turnId: written.turnId,
				...receipt,
			})
			const binding = document.budget?.binding
			if (binding) {
				ledgers.set(`${binding.rootSessionId}/${binding.rootTurnId}`, {
					rootSessionId: binding.rootSessionId,
					rootTurnId: binding.rootTurnId,
				})
			}
		} else {
			entry = await target.append(lease, draft)
		}
		hashes.set(entry.pointer.seq, entry.pointer.sha256)
	}
	for (const scope of ledgers.values()) {
		const ledger = await from?.tokenBudgets.load(scope)
		if (ledger) await storage.tokenBudget.save(scope, JSON.parse(JSON.stringify(ledger)))
	}
	await target.release(lease)
	return target
}
