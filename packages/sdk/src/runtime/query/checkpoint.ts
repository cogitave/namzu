import type { WorkingStateSnapshot } from '../../compaction/wire.js'
import { type TurnRecorder, readFoldedHistory } from '../../manager/session/turn-recorder.js'
import type { CheckpointScope, SessionCheckpointStore } from '../../store/checkpoint/index.js'
import type { SessionLog } from '../../store/session-log/index.js'
import type { SerializedSpanContext } from '../../telemetry/attributes.js'
import { NamzuError } from '../../types/errors/index.js'
import type {
	CheckpointId,
	CheckpointSummary,
	HITLDecisionRequest,
	HITLResumeDecision,
	PendingDecision,
} from '../../types/hitl/index.js'
import type { MessageId, TurnId } from '../../types/ids/index.js'
import type { AssistantMessage, Message, UserMessage } from '../../types/message/index.js'
import { CHECKPOINT_DOCUMENT_VERSION, type Checkpoint } from '../../types/session/checkpoint.js'
import type { CheckpointListEntry } from '../../types/session/fork.js'
import type { SessionRecord } from '../../types/session/records.js'
import { asGoalId, generateCheckpointId } from '../../utils/id.js'

/** Keep intent text/provenance without copying attachment payloads into a second slot. */
function snapshotUserIntent(value: unknown): UserMessage {
	const invalid = (): never => {
		throw new Error('Checkpoint latestUserMessage has invalid operator intent or provenance')
	}
	if (!value || typeof value !== 'object') return invalid()
	const message = value as Record<string, unknown>
	if (message.role !== 'user' || typeof message.content !== 'string') return invalid()
	const result: UserMessage = { role: 'user', content: message.content }
	if (message.timestamp !== undefined) {
		if (typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp))
			return invalid()
		result.timestamp = message.timestamp
	}
	if (message.source === undefined) return result
	if (!message.source || typeof message.source !== 'object') return invalid()
	const source = message.source as Record<string, unknown>
	if (source.type === 'runtime-context' && source.kind === 'steering') {
		result.source = { type: 'runtime-context', kind: 'steering' }
		return result
	}
	if (
		source.type !== 'goal-round' ||
		typeof source.goalId !== 'string' ||
		typeof source.objective !== 'string' ||
		![source.goalRevision, source.round, source.maxGoalRounds].every(
			(value) => typeof value === 'number' && Number.isInteger(value) && value > 0,
		)
	)
		return invalid()
	result.source = {
		type: 'goal-round',
		goalId: asGoalId(source.goalId),
		objective: source.objective,
		goalRevision: source.goalRevision as number,
		round: source.round as number,
		maxGoalRounds: source.maxGoalRounds as number,
	}
	return result
}

/** A checkpoint the turn just wrote: its id and the document. */
export interface CreatedCheckpoint {
	readonly id: CheckpointId
	readonly document: Checkpoint
}

/**
 * A checkpoint read back for a resume: the document, the context it
 * restores (the fold of the session log through `throughSeq`), and the
 * decision it is parked on, if any.
 */
export interface RestoredCheckpoint {
	readonly id: CheckpointId
	readonly document: Checkpoint
	readonly messages: Message[]
	/** Ids of the restored messages that have records, by message. */
	readonly messageIds: ReadonlyMap<Message, MessageId>
	readonly pending?: PendingDecision
	readonly latestUserMessage?: UserMessage
}

/** A decision one of a turn's checkpoints was parked on, as the log records it. */
export interface RecordedPark {
	readonly decisionId: string
	readonly turnId: TurnId
	readonly checkpointId: CheckpointId
	readonly pending: PendingDecision
}

/** Projection from a checkpoint document to the public listing entry. */
export function toCheckpointListEntry(cp: Checkpoint): CheckpointListEntry {
	return {
		id: cp.checkpointId,
		sessionId: cp.sessionId,
		turnId: cp.turnId,
		iteration: cp.iteration,
		createdAt: Date.parse(cp.createdAt),
		throughSeq: cp.throughSeq,
	}
}

/**
 * Every park a session log records, newest last: `decision_requested`, and
 * whether a `decision_resolved` or `decision_expired` has answered it.
 */
export async function readParks(
	log: SessionLog,
	options: { readonly turnId?: TurnId } = {},
): Promise<RecordedPark[]> {
	const parks = new Map<
		string,
		{
			decisionId: string
			turnId: TurnId
			checkpointId: CheckpointId
			request: HITLDecisionRequest
			parkedAt: number
			deadlineAt?: number
			resolvedAt?: number
			decision?: HITLResumeDecision
		}
	>()
	for await (const { record } of log.read({ mode: 'tolerant' })) {
		const r = record as SessionRecord
		if (r.type === 'decision_requested') {
			if (options.turnId !== undefined && r.turnId !== options.turnId) continue
			parks.set(r.decisionId, {
				decisionId: r.decisionId,
				turnId: r.turnId as TurnId,
				checkpointId: r.checkpointId,
				request: r.request as unknown as HITLDecisionRequest,
				parkedAt: Date.parse(r.ts),
				...(r.deadlineAt !== undefined ? { deadlineAt: Date.parse(r.deadlineAt) } : {}),
			})
		} else if (r.type === 'decision_resolved') {
			const park = parks.get(r.decisionId)
			if (park) {
				park.resolvedAt = Date.parse(r.ts)
				park.decision = r.decision
			}
		} else if (r.type === 'decision_expired') {
			const park = parks.get(r.decisionId)
			if (park) {
				park.resolvedAt = Date.parse(r.ts)
				// The park ended by running out of time, not by a decision. An
				// `abort` here would read as somebody having refused it.
				park.decision = {
					action: 'pause',
					reason: 'The approval request expired without an answer.',
				}
			}
		}
	}
	return [...parks.values()].map((park) => ({
		decisionId: park.decisionId,
		turnId: park.turnId,
		checkpointId: park.checkpointId,
		pending: {
			request: park.request,
			parkedAt: park.parkedAt,
			...(park.deadlineAt !== undefined ? { deadlineAt: park.deadlineAt } : {}),
			...(park.resolvedAt !== undefined ? { resolvedAt: park.resolvedAt } : {}),
			...(park.decision !== undefined ? { decision: park.decision } : {}),
		},
	}))
}

/**
 * The newest park of a session (or of one of its turns) that is still
 * awaiting a human decision, or `null` when nothing is parked.
 *
 * Standalone so a host can ask the question without constructing a turn: an
 * approval-queue worker in a different process has the session log and
 * nothing else. An expired park is not outstanding.
 */
export async function findPendingCheckpoint(
	log: SessionLog,
	options: { readonly turnId?: TurnId; readonly now?: number } = {},
): Promise<RecordedPark | null> {
	const parks = await readParks(log, options.turnId ? { turnId: options.turnId } : {})
	const now = options.now ?? Date.now()
	for (let i = parks.length - 1; i >= 0; i--) {
		const park = parks[i] as RecordedPark
		if (park.pending.resolvedAt !== undefined) continue
		if (isExpiredPark(park.pending, now)) continue
		return park
	}
	return null
}

/** Whether a park's absolute deadline has passed. No deadline never expires. */
export function isExpiredPark(pending: PendingDecision, now = Date.now()): boolean {
	return pending.deadlineAt !== undefined && now >= pending.deadlineAt
}

/**
 * Every outstanding park of a session whose deadline has passed, so a host
 * can sweep them (`CheckpointManager.expire`, or `decision_expired` appended
 * under the session lease).
 */
export async function listExpiredParks(
	log: SessionLog,
	options: { readonly turnId?: TurnId; readonly now?: number } = {},
): Promise<RecordedPark[]> {
	const parks = await readParks(log, options.turnId ? { turnId: options.turnId } : {})
	const now = options.now ?? Date.now()
	return parks.filter(
		(park) => park.pending.resolvedAt === undefined && isExpiredPark(park.pending, now),
	)
}

/**
 * What a {@link CheckpointManager} needs of the turn it serves: the log it
 * reads and appends to (in order with the turn's other records), and the
 * tenant decisions are attributed under. A {@link TurnRecorder} is one.
 */
export type CheckpointRecords = Pick<TurnRecorder, 'log' | 'appendRecord' | 'flush' | 'tenantId'>

/** Who answered a decision the turn itself carried out. */
function resolver(recorder: CheckpointRecords) {
	return {
		kind: 'system' as const,
		role: 'sys_approval_policy' as const,
		tenantId: recorder.tenantId,
	}
}

/**
 * A turn's checkpoints: documents in the session's checkpoint store,
 * committed by a `checkpoint_written` record, and the parks (`decision_*`
 * records) that reference them.
 *
 * A checkpoint holds no messages. Its context is the fold of the session log
 * through `throughSeq`; `restore` reads it back from the log and refuses a
 * checkpoint whose document or covered prefix no longer matches its record.
 */
export class CheckpointManager {
	private readonly recorder: CheckpointRecords
	private readonly store: SessionCheckpointStore
	private readonly scope: CheckpointScope
	private workingStateSource?: () => WorkingStateSnapshot | undefined
	private latestUserMessageSource?: () => UserMessage | undefined
	private restoredUserMessage?: UserMessage
	private restoredUserMessageId?: MessageId
	private answerReviewAttemptsSource?: () => number
	private restoredAnswerAttempts = 0
	private structuredReviewAttemptsSource?: () => number
	private restoredReviewAttempts = 0
	private nativeStructuredAttemptsSource?: () => number
	private restoredNativeAttempts = 0
	private lastCreatedId?: CheckpointId
	private traceSource?: () => SerializedSpanContext | undefined
	private parkTtlMs?: number
	/**
	 * The turn's attribution instant, identical on every checkpoint of the
	 * turn: adopted from the checkpoint a resume came back through, or minted
	 * from the turn's own start.
	 */
	private turnCreatedAt?: string

	constructor(recorder: CheckpointRecords, store: SessionCheckpointStore, scope: CheckpointScope) {
		this.recorder = recorder
		this.store = store
		this.scope = scope
	}

	/** Wire compaction's state in, so every checkpoint carries a snapshot. */
	setWorkingStateSource(source: () => WorkingStateSnapshot | undefined): void {
		this.workingStateSource = source
	}

	/** One current intent snapshot, including checkpoints created by tool/HITL paths. */
	setLatestUserMessageSource(source: () => UserMessage | undefined): void {
		this.latestUserMessageSource = source
	}

	get restoredLatestUserMessage(): UserMessage | undefined {
		return this.restoredUserMessage
	}

	setAnswerReviewAttemptsSource(source: () => number): void {
		this.answerReviewAttemptsSource = source
	}
	get restoredAnswerReviewAttempts(): number {
		return this.restoredAnswerAttempts
	}

	setNativeStructuredAttemptsSource(source: () => number): void {
		this.nativeStructuredAttemptsSource = source
	}
	get restoredNativeStructuredAttempts(): number {
		return this.restoredNativeAttempts
	}

	setStructuredReviewAttemptsSource(source: () => number): void {
		this.structuredReviewAttemptsSource = source
	}

	get restoredStructuredReviewAttempts(): number {
		return this.restoredReviewAttempts
	}

	/** The turn's root span, so every checkpoint records the trace it was taken inside. */
	setTraceSource(source: () => SerializedSpanContext | undefined): void {
		this.traceSource = source
	}

	/** Default time-to-live applied to every park this manager records. */
	setParkTtl(ttlMs: number | undefined): void {
		this.parkTtlMs = ttlMs
	}

	/**
	 * Write a checkpoint of the turn as it stands: every queued record lands
	 * first, the document names the log's head as `throughSeq`, and a
	 * `checkpoint_written` record commits it.
	 */
	async create(recorder: TurnRecorder, iteration: number): Promise<CreatedCheckpoint> {
		const startedAt = recorder.getTurn().startedAt
		this.turnCreatedAt ??= new Date(startedAt).toISOString()
		const latestUserMessage = this.latestUserMessageSource?.() ?? this.restoredUserMessage
		await recorder.budget?.flush()
		const head = await recorder.head()
		if (!head) throw new Error('A checkpoint needs a session log with records in it.')
		const latestUserMessageId = latestUserMessage
			? this.messageIdOf(recorder, latestUserMessage)
			: undefined
		const binding = recorder.budget?.binding
		const accountId = recorder.budget?.accountId
		const document: Checkpoint = {
			v: CHECKPOINT_DOCUMENT_VERSION,
			kind: 'checkpoint',
			checkpointId: generateCheckpointId(),
			sessionId: this.scope.sessionId,
			turnId: this.scope.turnId,
			iteration,
			throughSeq: head.pointer.seq,
			throughSha256: head.pointer.sha256,
			tokenUsage: { ...recorder.tokenUsage },
			costInfo: { ...recorder.costInfo },
			...(accountId !== undefined
				? { budget: { ...(binding ? { binding } : {}), accountId } }
				: {}),
			guards: {
				iteration: recorder.currentIteration,
				elapsedMs: Math.max(0, Date.now() - startedAt),
			},
			review: {
				structuredAttempts: this.structuredReviewAttemptsSource?.() ?? this.restoredReviewAttempts,
				answerAttempts: this.answerReviewAttemptsSource?.() ?? this.restoredAnswerAttempts,
				nativeStructuredAttempts:
					this.nativeStructuredAttemptsSource?.() ?? this.restoredNativeAttempts,
			},
			...(latestUserMessageId ? { latestUserMessageId } : {}),
			...withDefined('workingState', this.workingStateSource?.()),
			...withDefined('trace', this.traceSource?.()),
			turnCreatedAt: this.turnCreatedAt,
			createdAt: new Date().toISOString(),
		}
		const receipt = await this.store.write(this.scope, document)
		await recorder.appendRecord({
			type: 'checkpoint_written',
			turnId: this.scope.turnId,
			...receipt,
		})
		this.lastCreatedId = document.checkpointId
		return { id: document.checkpointId, document }
	}

	/** The id of a message the log holds, when the recorder recorded it. */
	private messageIdOf(recorder: TurnRecorder, message: Message): MessageId | undefined {
		if (message === this.restoredUserMessage) return this.restoredUserMessageId
		return recorder.recordedIdOf(message)
	}

	/** The most recent checkpoint this manager wrote, if any. */
	get lastCheckpointId(): CheckpointId | undefined {
		return this.lastCreatedId
	}

	/**
	 * The trace a checkpoint was taken inside, for parenting a resumed turn.
	 * Never throws: telemetry continuity is not worth failing a resume over.
	 */
	async readTraceContext(checkpointId: CheckpointId): Promise<SerializedSpanContext | undefined> {
		try {
			const checkpoint = await this.store.read(this.scope, checkpointId)
			return checkpoint?.trace
		} catch {
			return undefined
		}
	}

	/**
	 * Record that the turn parked at `checkpoint` awaiting a human: a
	 * `decision_requested` record naming the checkpoint, with an absolute
	 * deadline when the turn has a park time-to-live.
	 */
	async park(
		checkpoint: { readonly id: CheckpointId },
		request: HITLDecisionRequest,
		options?: { readonly ttlMs?: number },
	): Promise<PendingDecision> {
		const parkedAt = Date.now()
		const ttl = options?.ttlMs ?? this.parkTtlMs
		const deadlineAt = ttl !== undefined && ttl > 0 ? parkedAt + ttl : undefined
		await this.recorder.appendRecord({
			type: 'decision_requested',
			turnId: this.scope.turnId,
			decisionId: checkpoint.id,
			checkpointId: checkpoint.id,
			request: request as never,
			...(deadlineAt !== undefined ? { deadlineAt: new Date(deadlineAt).toISOString() } : {}),
		})
		return { request, parkedAt, ...(deadlineAt !== undefined ? { deadlineAt } : {}) }
	}

	/**
	 * Mark an expired park as no longer outstanding: `decision_expired`. The
	 * request stays in the log as evidence of what was asked.
	 */
	async expire(checkpointId: CheckpointId): Promise<RecordedPark | null> {
		const park = await this.openPark(checkpointId)
		if (!park) return null
		await this.recorder.appendRecord({
			type: 'decision_expired',
			turnId: this.scope.turnId,
			decisionId: park.decisionId,
		})
		return park
	}

	/**
	 * Record the answer, so an outstanding park stops looking outstanding:
	 * `decision_resolved`. A no-op when the checkpoint was never parked or the
	 * park is already answered.
	 */
	async unpark(
		checkpointId: CheckpointId,
		decision: HITLResumeDecision,
	): Promise<RecordedPark | null> {
		const park = await this.openPark(checkpointId)
		if (!park) return null
		await this.recorder.appendRecord({
			type: 'decision_resolved',
			turnId: this.scope.turnId,
			decisionId: park.decisionId,
			decision,
			resolvedBy: resolver(this.recorder),
		})
		return park
	}

	private async openPark(checkpointId: CheckpointId): Promise<RecordedPark | null> {
		await this.recorder.flush()
		const parks = await readParks(this.recorder.log, { turnId: this.scope.turnId })
		return (
			parks.find(
				(park) => park.checkpointId === checkpointId && park.pending.resolvedAt === undefined,
			) ?? null
		)
	}

	/** The turn's outstanding park, if it has one. */
	async findPending(): Promise<RecordedPark | null> {
		await this.recorder.flush()
		return findPendingCheckpoint(this.recorder.log, { turnId: this.scope.turnId })
	}

	/**
	 * Read a checkpoint back for a resume. Refused when it is missing, when
	 * its document no longer matches its record, or when the log prefix it
	 * covers changed.
	 */
	async restore(checkpointId: CheckpointId): Promise<RestoredCheckpoint> {
		const document = await this.store.restore(this.scope, checkpointId)
		if (!document) {
			throw new NamzuError({
				code: 'not_found',
				message: `Checkpoint not found: ${checkpointId}`,
				details: { checkpointId, sessionId: this.scope.sessionId, turnId: this.scope.turnId },
			})
		}
		const restored = await restoreCheckpointContext(this.recorder.log, document)
		this.turnCreatedAt ??= document.turnCreatedAt
		this.restoredAnswerAttempts = document.review.answerAttempts
		this.restoredNativeAttempts = document.review.nativeStructuredAttempts
		this.restoredReviewAttempts = document.review.structuredAttempts
		this.restoredUserMessage = restored.latestUserMessage
		this.restoredUserMessageId = restored.latestUserMessage
			? document.latestUserMessageId
			: undefined
		return restored
	}

	/** The turn's checkpoint documents, oldest first. */
	async list(): Promise<Checkpoint[]> {
		return this.store.list(this.scope)
	}

	/** Listing projection used by the public `listCheckpoints` API. */
	async listEntries(): Promise<CheckpointListEntry[]> {
		return (await this.list()).map(toCheckpointListEntry)
	}

	/**
	 * Collect old checkpoints until `keepLast` newer ones remain, never one an
	 * open decision references; a `checkpoint_pruned` record names what went.
	 */
	async prune(keepLast: number): Promise<void> {
		await this.recorder.flush()
		const pruned = await this.store.prune(this.scope, keepLast)
		if (pruned.length > 0) {
			await this.recorder.appendRecord({
				type: 'checkpoint_pruned',
				turnId: this.scope.turnId,
				checkpointIds: pruned,
			})
		}
	}

	static buildSummary(recorder: TurnRecorder, iteration: number): CheckpointSummary {
		const lastAssistant = [...recorder.messages]
			.reverse()
			.find((m): m is AssistantMessage => m.role === 'assistant' && m.content !== null)

		return {
			iteration,
			messageCount: recorder.messages.length,
			tokenUsage: { ...recorder.tokenUsage },
			costInfo: { ...recorder.costInfo },
			lastAssistantMessage: lastAssistant?.content ?? undefined,
		}
	}
}

/**
 * The context a checkpoint restores: the fold of its session log through
 * `throughSeq`, the decision it is parked on, and the operator intent it
 * names.
 */
export async function restoreCheckpointContext(
	log: SessionLog,
	document: Checkpoint,
): Promise<RestoredCheckpoint> {
	const history = await readFoldedHistory(log, { throughSeq: document.throughSeq })
	const messages = history.map((entry) => entry.message)
	const messageIds = new Map<Message, MessageId>()
	for (const entry of history) {
		if (entry.messageId) messageIds.set(entry.message, entry.messageId)
	}
	const park = (await readParks(log, { turnId: document.turnId }))
		.filter((candidate) => candidate.checkpointId === document.checkpointId)
		.at(-1)
	const intent =
		document.latestUserMessageId === undefined
			? undefined
			: history.find((entry) => entry.messageId === document.latestUserMessageId)?.message
	return {
		id: document.checkpointId,
		document,
		messages,
		messageIds,
		...(park ? { pending: park.pending } : {}),
		...(intent ? { latestUserMessage: snapshotUserIntent(intent) } : {}),
	}
}

function withDefined<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}
