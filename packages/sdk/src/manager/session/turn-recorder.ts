import { AUTO_CONTINUATION_USER_MESSAGE } from '../../constants/continuation.js'
import { EMPTY_TOKEN_USAGE } from '../../constants/limits.js'
import { NAMZU } from '../../constants/telemetry/index.js'
import { resolveModelPricing } from '../../pricing/index.js'
import type { SessionTokenBudget } from '../../store/budget/index.js'
import type { SessionCheckpointStore } from '../../store/checkpoint/index.js'
import {
	type SessionLease,
	type SessionLog,
	type SessionLogEntry,
	type SessionLogHead,
	SessionMessageFold,
	withMessageId,
} from '../../store/session-log/index.js'
import type { SpillRef } from '../../store/session-log/spill.js'
import { getActiveSpanContext } from '../../telemetry/runtime-accessors.js'
import {
	type CostInfo,
	type TokenUsage,
	accumulateTokenUsage,
	isTerminalStatus,
	mergeTokenUsage,
} from '../../types/common/index.js'
import { NamzuError } from '../../types/errors/index.js'
import type { MessageId, SessionId, TenantId, TurnId } from '../../types/ids/index.js'
import type { AssistantMessage, Message } from '../../types/message/index.js'
import type { ProviderErrorInfo } from '../../types/provider/index.js'
import type { AuditEvent, AuditEventInput } from '../../types/session/audit.js'
import type { TurnRecorderConfig } from '../../types/session/config.js'
import {
	type SessionEvent,
	type SessionEventType,
	isEphemeralEvent,
} from '../../types/session/events.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import type { SessionRecord } from '../../types/session/records.js'
import type { StepResult } from '../../types/session/step.js'
import type { StopReason } from '../../types/session/stop-reason.js'
import {
	type Origin,
	type Turn,
	type TurnConfigSnapshot,
	type TurnForkOrigin,
	TurnInProgressError,
	type TurnResultSource,
	type TurnSettlement,
} from '../../types/session/turn.js'
import {
	type ModelPricing,
	ZERO_COST,
	accumulateCost,
	accumulateUnpricedCost,
} from '../../utils/cost.js'
import { asCheckpointId, generateAuditEventId, generateMessageId } from '../../utils/id.js'
import { childSessionEnded } from '../agent/child-session.js'
import { assertSessionLogAttribution } from './attribution.js'

/** Which provider and model a cost is priced against. */
export interface PricingSubject {
	readonly providerId: string
	readonly model: string | undefined
}

/** One message of a session's folded history, with the id its record gave it. */
export interface RecordedMessage {
	readonly message: Message
	/** Absent for a compaction summary message, which has no record of its own. */
	readonly messageId?: MessageId
}

/**
 * Stamp (or clear) `id` on a message already living in `recorder.messages`,
 * in place — the recorder's own bookkeeping (`#ids`, `#recorded`, `#view`)
 * is keyed by object IDENTITY, so replacing the array element the way
 * `withMessageId` does would desync it. `recorder.messages`/`Turn.messages`
 * is the one place a message a HOST passed in is allowed to change under
 * it: once the kernel records that exact object, it is stamped with the id
 * its record was given, which is the id `BaseMessage.id` documents. A
 * message read from the log for a DIFFERENT purpose (a fold a host did not
 * hand in, a checkpoint restore) is never this function's object — it goes
 * through `withMessageId`, a copy, because nothing here owns it to mutate.
 */
function stampMessageId(message: Message, id: MessageId | undefined): void {
	if (id === undefined) delete (message as { id?: MessageId }).id
	else (message as { id?: MessageId }).id = id
}

/** How {@link TurnRecorder.open} takes the session's writer lease and starts an empty log. */
export interface TurnRecorderOpenOptions {
	/** A lease the caller already holds. Absent: the recorder claims one and releases it at the end. */
	readonly lease?: SessionLease
	/** A lease claimed by the query prelude, transferred to the recorder for release. */
	readonly ownLease?: boolean
	/** The holder name for a lease the recorder claims. */
	readonly holder?: string
	/** Lease time-to-live for a lease the recorder claims. Renewed while the turn runs. */
	readonly leaseTtlMs?: number
	/** Written into `session_started` when the log is empty. */
	readonly session: {
		readonly cwd: string
		readonly origin?: Origin
		readonly agentType?: string
		/** The session this one was forked from (`session_started.forkedFrom`). */
		readonly forkedFrom?: TurnForkOrigin
	}
}

/** The payload of `turn_started` a caller supplies; the rest comes from the recorder. */
export interface TurnBeginDraft {
	readonly systemPrompt?: string
	readonly origin?: Origin
	/** Close an interrupted active turn first (`beginTurn({ abandonInterrupted })`). */
	readonly abandonInterrupted?: boolean
}

/** Default lease time-to-live: renewed at half-life while the turn runs. */
export const DEFAULT_TURN_LEASE_TTL_MS = 5 * 60_000

/** Record types that may carry `turnId` only while the turn is active. */
const TURN_BOUND_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set<SessionEventType>([
	'tool_calls_admitted',
	'iteration_started',
	'request_envelope',
	'iteration_completed',
	'tool_executing',
	'hosted_tool',
	'provider_retry',
	'provider_fallback',
	'tool_completed',
	'user_question_asked',
	'user_question_answered',
	'tool_review_requested',
	'tool_review_completed',
	'checkpoint_created',
	'guardrail_triggered',
	'message_history_repaired',
	'token_usage_updated',
	'activity_created',
	'activity_updated',
	'plan_ready',
	'plan_approved',
	'plan_rejected',
	'plan_step_updated',
	'plan_completed',
	'plan_failed',
	'agent_pending',
	'agent_completed',
	'agent_failed',
	'agent_canceled',
	'message_started',
	'reasoning_started',
	'reasoning_completed',
	'message_completed',
	'tool_input_started',
	'tool_input_completed',
	'turn_started',
	'turn_paused',
	'turn_resuming',
	'turn_completed',
	'turn_failed',
	'child_session_spawned',
])

interface ViewEntry {
	message: Message
	/** Present once the message has a `message` record. */
	id?: MessageId
	/** Present in the context but never recorded (the rebuilt system prompt). */
	transient?: boolean
}

type Phase = 'new' | 'open' | 'active' | 'paused' | 'closed'

/**
 * Records one turn into its session log: `turn_started`, every `message`
 * when the message ends (not when the turn ends), checkpoints, audit
 * entries, and the settling `turn_completed`/`turn_failed`. When the final
 * `result` differs from the text of the turn's last assistant message it
 * appends `message_replaced` first, so every fold shows the answer the host
 * was given.
 *
 * It writes under the session lease and holds no other durable state: no
 * `run.json`, `messages.json` or `report.md`.
 *
 * ## Messages
 *
 * The context (`messages`) is a plain array the loop pushes to and, during
 * compaction, rewrites in place. The recorder keeps a view of what the log
 * already holds and reconciles the array against it before every append:
 * messages added at the end become `message` records; any other change —
 * a compaction, a pinned slot rewritten, a message removed — becomes one
 * `compaction` record whose fold is exactly the new array. The rebuilt
 * system prompt is pushed as transient and never recorded: `turn_started`
 * carries it.
 *
 * Message appends are queued in order with every other record; a failed
 * append is reported by the next awaited write ({@link flush}).
 */
export class TurnRecorder {
	readonly sessionId: SessionId
	readonly turnId: TurnId
	readonly budget?: SessionTokenBudget
	readonly log: SessionLog

	readonly #config: TurnRecorderConfig
	readonly #turn: Turn
	#phase: Phase = 'new'
	/**
	 * The segment's closing record (`turn_paused`, `turn_completed`,
	 * `turn_failed`) is queued. `#phase` moves only once it has landed; from
	 * the moment it is queued, nothing else may be queued under the turn's id,
	 * because it would land after the turn has ended.
	 */
	#ending = false
	#lease: SessionLease | undefined
	#ownsLease = false
	/** The recorder gave its lease up: it is no longer the session's writer. */
	#released = false
	#leaseHolder = ''
	#leaseTtlMs = DEFAULT_TURN_LEASE_TTL_MS
	#leaseHeartbeat: ReturnType<typeof setInterval> | undefined
	#leaseRenewal: Promise<void> = Promise.resolve()
	#leaseRenewalError: unknown
	#chain: Promise<void> = Promise.resolve()
	#failure: unknown = undefined
	#view: ViewEntry[] = []
	readonly #ids = new Map<Message, MessageId>()
	/** Every message's record id, kept after a compaction drops it from the fold. */
	readonly #recorded = new WeakMap<Message, MessageId>()
	readonly #transient = new WeakSet<Message>()
	#resultOverridden = false
	#resultSource: TurnResultSource = 'model'
	#lastPromptTokens: number | undefined
	#lastPromptMessageCount: number | undefined
	#lastEntry: SessionLogEntry | undefined
	#auditSeq = 0
	#userMessageId: MessageId | undefined
	/** Set by {@link resume}: the next reconciliation re-bases the fold on the restored context. */
	#rebasePending = false
	/**
	 * The message ids of the log's fold when the turn resumed, oldest first;
	 * `undefined` when the fold holds a message with no record of its own (a
	 * compaction summary). A restored context whose recorded ids are exactly
	 * these needs no re-basing, so no `compaction` record is written for it.
	 */
	#foldIdsAtResume: readonly MessageId[] | undefined
	/** When a resumed turn began: its `turn_started` record, not this process's start. */
	#resumedTurnStartedAt: number | undefined

	constructor(config: TurnRecorderConfig) {
		this.#config = config
		this.sessionId = config.sessionId
		this.turnId = config.turnId
		this.budget = config.budget
		this.log = config.sessionLog
		if (config.sessionLog.sessionId !== config.sessionId) {
			throw new NamzuError({
				code: 'invalid_config',
				message: `The session log belongs to session ${config.sessionLog.sessionId}, not ${config.sessionId}.`,
				details: {
					sessionId: config.sessionId,
					logSessionId: config.sessionLog.sessionId,
				},
			})
		}
		this.#turn = {
			id: config.turnId,
			sessionId: config.sessionId,
			status: 'idle',
			metadata: {
				scope: {
					tenantId: config.tenantId,
					projectId: config.projectId,
					sessionId: config.sessionId,
					turnId: config.turnId,
				},
				agentId: config.agentId,
				agentName: config.agentName,
				config: config.turnConfig,
				provider: config.providerId,
				...(config.parentSessionId ? { parentSessionId: config.parentSessionId } : {}),
				...(config.parentTurnId ? { parentTurnId: config.parentTurnId } : {}),
			},
			messages: [],
			tokenUsage: { ...EMPTY_TOKEN_USAGE },
			costInfo: { ...ZERO_COST },
			currentIteration: 0,
			startedAt: Date.now(),
			...(config.parentSessionId ? { parentSessionId: config.parentSessionId } : {}),
			...(config.parentTurnId ? { parentTurnId: config.parentTurnId } : {}),
			...(config.depth !== undefined ? { depth: config.depth } : {}),
		}
	}

	// ─── identity ──────────────────────────────────────────────────────────

	get topicId(): TopicId {
		return this.#config.topicId
	}

	get tenantId(): TenantId {
		return this.#config.tenantId
	}

	get projectId(): ProjectId {
		return this.#config.projectId
	}

	get parentSessionId(): SessionId | undefined {
		return this.#config.parentSessionId
	}

	get parentTurnId(): TurnId | undefined {
		return this.#config.parentTurnId
	}

	get checkpointStore(): SessionCheckpointStore | undefined {
		return this.#config.checkpointStore
	}

	/** The lease the turn's records are written under, once {@link open} has run. */
	get lease(): SessionLease | undefined {
		return this.#lease
	}

	/** The id of the prompt message `turn_started` names. */
	get userMessageId(): MessageId | undefined {
		return this.#userMessageId
	}

	/** Seq of the last record this recorder appended. */
	get lastSeq(): number {
		return this.#lastEntry?.record.seq ?? 0
	}

	/** Whether the turn has begun (or resumed) and not paused or settled. */
	get isActive(): boolean {
		return this.#phase === 'active'
	}

	/** Whether the turn's last segment record is `turn_paused`. */
	get isPaused(): boolean {
		return this.#phase === 'paused'
	}

	/** Whether the turn has a terminal record. */
	get isClosed(): boolean {
		return this.#phase === 'closed'
	}

	// ─── the turn ──────────────────────────────────────────────────────────

	get status() {
		return this.#turn.status
	}

	get stopReason() {
		return this.#turn.stopReason
	}

	get messages(): Message[] {
		return this.#turn.messages
	}

	get tokenUsage(): TokenUsage {
		return this.budget
			? mergeTokenUsage(this.#turn.tokenUsage, this.budget.ownUsage)
			: this.#turn.tokenUsage
	}

	get costInfo(): CostInfo {
		const unpriced = Math.max(0, this.tokenUsage.totalTokens - this.#turn.tokenUsage.totalTokens)
		return unpriced > 0
			? {
					...this.#turn.costInfo,
					unpricedTokens: this.#turn.costInfo.unpricedTokens + unpriced,
				}
			: this.#turn.costInfo
	}

	get currentIteration(): number {
		return this.#turn.currentIteration
	}

	/** The turn as it stands. */
	get turn(): Turn {
		return this.getTurn()
	}

	getTurn(): Readonly<Turn> {
		if (!this.budget) return this.#turn
		return {
			...this.#turn,
			tokenUsage: this.tokenUsage,
			costInfo: this.costInfo,
			budget: this.budget.summary(),
			...(this.budget.binding ? { budgetBinding: this.budget.binding } : {}),
		}
	}

	#syncBudget(): void {
		if (!this.budget) return
		this.#turn.costInfo = this.costInfo
		this.#turn.tokenUsage = this.tokenUsage
		this.#turn.budget = this.budget.summary()
		if (this.budget.binding) this.#turn.budgetBinding = this.budget.binding
	}

	markRunning(): void {
		this.#turn.status = 'running'
	}

	markCompleted(stopReason?: StopReason): void {
		this.#turn.status = 'completed'
		if (stopReason) this.#turn.stopReason = stopReason
		this.#turn.endedAt = Date.now()
		this.#resolveResult()
	}

	markFailed(error: string, providerError?: ProviderErrorInfo): void {
		this.clearStructuredOutput()
		this.#turn.status = 'failed'
		this.#turn.stopReason = 'error'
		this.#turn.lastError = error
		if (providerError) this.#turn.lastProviderError = providerError
		this.#turn.endedAt = Date.now()
	}

	markCancelled(): void {
		this.clearStructuredOutput()
		this.#turn.status = 'cancelled'
		this.#turn.stopReason = 'cancelled'
		this.#turn.endedAt = Date.now()
	}

	setStopReason(reason: StopReason): void {
		this.#turn.stopReason = reason
	}

	setLastError(error: string, providerError?: ProviderErrorInfo): void {
		this.#turn.lastError = error
		if (providerError) this.#turn.lastProviderError = providerError
	}

	incrementIteration(): number {
		this.#turn.currentIteration++
		return this.#turn.currentIteration
	}

	/**
	 * Override the turn's final text. Sticky: `markCompleted` re-derives the
	 * result from the message tail, and would otherwise put the raw model
	 * text back. `source` names which override decided it; anything but
	 * `model` makes settling append `message_replaced`.
	 */
	setResult(result: string, source: TurnResultSource): void {
		this.#turn.result = result
		this.#resultOverridden = true
		this.#resultSource = source
	}

	/** Which override decided `result` (`model` when none did). */
	get resultSource(): TurnResultSource {
		return this.#resultSource
	}

	/** Invalidate a structured value without replacing the host's textual result. */
	clearStructuredOutput(): void {
		delete this.#turn.structuredOutput
	}

	/** Record the schema-validated answer, and make `result` agree with it. */
	setStructuredOutput(value: unknown): void {
		this.#turn.structuredOutput = value
		this.setResult(typeof value === 'string' ? value : JSON.stringify(value), 'structured_output')
	}

	setAbandonedTaskIds(taskIds: readonly string[]): void {
		if (taskIds.length === 0) return
		this.#turn.abandonedTaskIds = [...taskIds]
	}

	setAbandonedJobIds(jobIds: readonly string[]): void {
		if (jobIds.length === 0) return
		this.#turn.abandonedJobIds = [...jobIds]
	}

	setSteps(steps: readonly StepResult[]): void {
		this.#turn.steps = steps
	}

	/** Record that a provider chain advanced, so the turn stops naming a member that did not serve. */
	setServingProvider(providerId: string): void {
		this.#turn.metadata.servingProvider = providerId
	}

	/** Who is serving right now, for a side-channel call with no provenance of its own. */
	get servingProviderId(): string {
		return this.#turn.metadata.servingProvider ?? this.#turn.metadata.provider
	}

	#resolvePricing(servedBy: PricingSubject): ModelPricing | undefined {
		if (this.#config.pricing) return this.#config.pricing
		return resolveModelPricing(servedBy.providerId, servedBy.model)
	}

	accumulateUsage(usage: TokenUsage, servedBy: PricingSubject): void {
		this.#turn.tokenUsage = accumulateTokenUsage(this.#turn.tokenUsage, usage)
		const pricing = this.#resolvePricing(servedBy)
		this.#turn.costInfo =
			pricing === undefined
				? accumulateUnpricedCost(this.#turn.costInfo, usage)
				: accumulateCost(this.#turn.costInfo, usage, pricing)
	}

	/**
	 * Accumulate usage from a main-loop request, and remember its prompt size:
	 * the provider's own measurement of the context it just received, which
	 * compaction needs. Side-channel calls use {@link accumulateUsage}.
	 */
	recordTurnUsage(usage: TokenUsage, servedBy: PricingSubject): void {
		this.accumulateUsage(usage, servedBy)
		this.#lastPromptTokens = usage.promptTokens
		this.#lastPromptMessageCount = this.#turn.messages.length
	}

	/** Forget the last prompt measurement (after compaction replaced the context it described). */
	clearLastPromptTokens(): void {
		this.#lastPromptTokens = undefined
		this.#lastPromptMessageCount = undefined
	}

	get lastPromptTokens(): number | undefined {
		return this.#lastPromptTokens
	}

	get lastPromptMessageCount(): number | undefined {
		return this.#lastPromptMessageCount
	}

	/** Seed the spend counters from a checkpoint so a resumed turn continues its budget. */
	restoreUsage(tokenUsage: TokenUsage, costInfo: CostInfo, currentIteration: number): void {
		this.#turn.tokenUsage = { ...tokenUsage }
		this.#turn.costInfo = { ...costInfo }
		this.#turn.currentIteration = currentIteration
		this.budget?.recordUsage(tokenUsage)
		this.#syncBudget()
	}

	/** Assemble the final assistant output WITHOUT settling the turn. */
	materializeResult(): string {
		this.#resolveResult()
		return this.#turn.result ?? ''
	}

	#resolveResult(): void {
		if (this.#resultOverridden) return
		// Walk the tail: an auto-continuation prompt between two assistant
		// messages is transparent, so a turn split by `max_tokens` keeps its
		// whole answer.
		const chunks: string[] = []
		for (let i = this.#turn.messages.length - 1; i >= 0; i--) {
			const msg = this.#turn.messages[i]
			if (!msg) continue
			if (msg.role === 'assistant') {
				if (msg.content !== null) chunks.push(msg.content)
				continue
			}
			if (msg.role === 'user' && msg.content === AUTO_CONTINUATION_USER_MESSAGE) continue
			break
		}
		if (chunks.length > 0) this.#turn.result = chunks.reverse().join('')
	}

	/** The settlement a terminal record carries, from the turn as it stands. */
	settlement(status: TurnSettlement['status']): TurnSettlement {
		const turn = this.getTurn()
		const resultMessageId = this.#lastAssistantEntry()?.id
		return {
			status,
			iterations: turn.currentIteration,
			usage: { ...turn.tokenUsage },
			cost: { ...turn.costInfo },
			durationMs: Math.max(0, (turn.endedAt ?? Date.now()) - turn.startedAt),
			...(resultMessageId ? { resultMessageId } : {}),
			resultSource: this.#resultSource,
			...(turn.structuredOutput !== undefined ? { structuredOutput: turn.structuredOutput } : {}),
			...(turn.metadata.servingProvider ? { servingProvider: turn.metadata.servingProvider } : {}),
			abandonedTaskIds: [...(turn.abandonedTaskIds ?? [])],
			abandonedJobIds: [...(turn.abandonedJobIds ?? [])],
		}
	}

	// ─── the log ───────────────────────────────────────────────────────────

	/**
	 * Take the writer lease (or adopt the caller's) and start an empty log
	 * with `session_started`. Returns the session's folded history.
	 */
	async open(options: TurnRecorderOpenOptions): Promise<RecordedMessage[]> {
		if (this.#phase !== 'new') throw new Error('TurnRecorder.open was already called.')
		this.#leaseTtlMs = options.leaseTtlMs ?? DEFAULT_TURN_LEASE_TTL_MS
		this.#leaseHolder =
			options.holder ?? options.lease?.holder ?? `namzu:${process.pid}:${this.turnId}`
		try {
			if (options.lease) {
				this.#lease = options.lease
				this.#ownsLease = options.ownLease === true
			}
			// Claiming a log may repair a torn tail. Refuse a foreign owner
			// before that mutation, then recheck under the lease below.
			await assertSessionLogAttribution(this.log, this.#config)
			if (!options.lease) {
				const lease = await this.log.claim({
					holder: this.#leaseHolder,
					ttlMs: this.#leaseTtlMs,
					repairTornTail: false,
				})
				if (lease === null) {
					const active = await this.log.activeTurn()
					if (active) {
						throw new TurnInProgressError({
							sessionId: this.sessionId,
							activeTurnId: active.turnId,
							state: 'running',
						})
					}
					throw new NamzuError({
						code: 'invalid_config',
						message: `Session ${this.sessionId} is leased by another writer; wait for it to finish or pass the lease you hold.`,
						details: { sessionId: this.sessionId },
					})
				}
				this.#lease = lease
				this.#ownsLease = true
			}
			const lease = this.#lease
			if (!lease) throw new Error('TurnRecorder.open did not acquire a writer lease.')
			if (this.#ownsLease) {
				this.#leaseHeartbeat = setInterval(() => this.#queueLeaseRenewal(), this.#leaseTtlMs / 2)
				this.#leaseHeartbeat.unref()
			}
			const head = await this.log.head()
			if (head === null) {
				this.#lastEntry = await this.log.append(lease, {
					type: 'session_started',
					projectId: this.projectId,
					tenantId: this.tenantId,
					topicId: this.topicId,
					cwd: options.session.cwd,
					agent: {
						id: this.#config.agentId,
						name: this.#config.agentName,
						...(options.session.agentType ? { type: options.session.agentType } : {}),
					},
					...(options.session.origin ? { origin: options.session.origin } : {}),
					...(options.session.forkedFrom ? { forkedFrom: options.session.forkedFrom } : {}),
				})
			} else {
				await assertSessionLogAttribution(this.log, this.#config)
			}
			if (options.session.forkedFrom) {
				this.#turn.forkedFrom = options.session.forkedFrom
			}
			this.#phase = 'open'
			return await readFoldedHistory(this.log)
		} catch (error) {
			await this.release()
			throw error
		}
	}

	/** Serialize timer and write-triggered renewals so release uses the latest token. */
	#queueLeaseRenewal(): void {
		this.#leaseRenewal = this.#leaseRenewal
			.then(async () => {
				if (!this.#ownsLease || this.#released || this.#leaseRenewalError !== undefined) return
				const current = this.#lease
				if (!current) return
				const renewed = await this.log.claim({
					holder: this.#leaseHolder,
					ttlMs: this.#leaseTtlMs,
					repairTornTail: false,
				})
				if (renewed === null || renewed.fence !== current.fence) {
					if (renewed !== null) await this.log.release(renewed).catch(() => undefined)
					throw new NamzuError({
						code: 'invalid_config',
						message: `Session ${this.sessionId} lost its writer lease during the turn.`,
						details: { sessionId: this.sessionId },
					})
				}
				this.#lease = renewed
			})
			.catch((error: unknown) => {
				this.#leaseRenewalError ??= error
			})
	}

	/** Renew a lease this recorder claimed when it is past half its life. */
	async #leaseForWrite(): Promise<SessionLease> {
		if (!this.#lease) throw new Error('TurnRecorder.open must run before the turn writes.')
		if (this.#ownsLease) {
			await this.#leaseRenewal
			if (this.#leaseRenewalError !== undefined) throw this.#leaseRenewalError
			if (this.#lease.expiresAt - Date.now() < this.#leaseTtlMs / 2) {
				this.#queueLeaseRenewal()
				await this.#leaseRenewal
				if (this.#leaseRenewalError !== undefined) throw this.#leaseRenewalError
			}
		}
		return this.#lease as SessionLease
	}

	/** Give up a lease the recorder claimed. Never throws. */
	async release(): Promise<void> {
		if (!this.#ownsLease || !this.#lease) return
		this.#released = true
		if (this.#leaseHeartbeat !== undefined) clearInterval(this.#leaseHeartbeat)
		this.#leaseHeartbeat = undefined
		await this.#leaseRenewal
		this.#ownsLease = false
		await this.log.release(this.#lease).catch(() => undefined)
	}

	#enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.#chain.then(async () => {
			if (this.#failure !== undefined) throw this.#failure
			return operation()
		})
		this.#chain = run.then(
			() => undefined,
			(error: unknown) => {
				this.#failure ??= error
			},
		)
		return run
	}

	/** Wait for every queued append; rethrow the first that failed. */
	async flush(): Promise<void> {
		await this.#chain
		if (this.#failure !== undefined) throw this.#failure
	}

	async #append(draft: Parameters<SessionLog['append']>[1]): Promise<SessionLogEntry> {
		const entry = await this.log.append(await this.#leaseForWrite(), draft)
		this.#lastEntry = entry
		return entry
	}

	/** The log's last record once every queued append has landed: what a checkpoint is taken through. */
	async head(): Promise<SessionLogHead | null> {
		this.#syncMessages()
		await this.flush()
		return this.log.head()
	}

	/**
	 * Begin the turn: `turn_started`, then the messages pushed so far. The
	 * prompt that opened it is the last new user message pushed before this.
	 */
	async begin(draft: TurnBeginDraft = {}): Promise<SessionLogEntry> {
		if (this.#phase !== 'open') throw new Error('The turn has already begun.')
		const pendingUser = this.#pendingNew()
			.reverse()
			.find((m) => m.role === 'user')
		const userMessageId = pendingUser ? this.#idFor(pendingUser) : generateMessageId()
		this.#userMessageId = userMessageId
		const binding = this.budget?.binding
		const entry = await this.#enqueue(async () => {
			const begun = await this.log.beginTurn(
				await this.#leaseForWrite(),
				{
					turnId: this.turnId,
					userMessageId,
					...(draft.systemPrompt !== undefined ? { systemPrompt: draft.systemPrompt } : {}),
					config: snapshotTurnConfig(this.#config.turnConfig),
					...(draft.origin ? { origin: draft.origin } : {}),
					...(binding ? { budget: binding } : {}),
				},
				draft.abandonInterrupted ? { abandonInterrupted: true } : {},
			)
			this.#lastEntry = begun
			return begun
		})
		this.#phase = 'active'
		this.#syncMessages()
		return entry
	}

	/** Continue a paused or interrupted turn: `turn_resuming`, same `turnId`. */
	async resume(fromCheckpointId: string, resolvedDecisionId?: string): Promise<SessionLogEntry> {
		if (this.#phase !== 'open') throw new Error('The turn has already begun.')
		const entry = await this.#enqueue(() =>
			this.#append({
				type: 'turn_resuming',
				turnId: this.turnId,
				fromCheckpointId: asCheckpointId(fromCheckpointId),
				...(resolvedDecisionId ? { resolvedDecisionId } : {}),
			}),
		)
		this.#phase = 'active'
		// The log may hold records past the checkpoint (a crash after it); the
		// fold is re-based on the context the resume restores, once it has been
		// pushed, unless that context is the one the log already folds to.
		this.#foldIdsAtResume = await this.#readResumedLog()
		this.#rebasePending = true
		return entry
	}

	/**
	 * When the turn began. For a resumed turn this is its `turn_started`
	 * record's time, so "closed in this turn" still counts what the turn did
	 * before it paused, in whichever process that was.
	 */
	get turnStartedAt(): number {
		return this.#resumedTurnStartedAt ?? this.#turn.startedAt
	}

	/**
	 * Read the log once on resume: the fold's message ids at its head
	 * (`undefined` when one has no record), and when this turn began.
	 */
	async #readResumedLog(): Promise<readonly MessageId[] | undefined> {
		await this.flush()
		const fold = new SessionMessageFold()
		for await (const entry of this.log.read()) {
			const record = entry.record as SessionRecord
			if (record.type === 'turn_started' && record.turnId === this.turnId) {
				const at = Date.parse(record.ts)
				if (Number.isFinite(at)) this.#resumedTurnStartedAt = at
			}
			fold.apply(record)
		}
		if (fold.spilledSummary) return undefined
		const ids: MessageId[] = []
		for (const entry of fold.entries()) {
			if (!entry.messageId) return undefined
			ids.push(entry.messageId)
		}
		return ids
	}

	/** The recorded context is exactly what the log folds to: a resume changed nothing. */
	#viewMatchesFold(): boolean {
		const expected = this.#foldIdsAtResume
		if (!expected) return false
		const durable = this.#view.filter((entry) => !entry.transient)
		if (durable.length !== expected.length) return false
		return durable.every((entry, index) => entry.id === expected[index])
	}

	/**
	 * Append a record-only draft (a checkpoint, a decision, an audit entry)
	 * after every queued message.
	 */
	appendRecord(draft: Parameters<SessionLog['append']>[1]): Promise<SessionLogEntry> {
		this.#syncMessages()
		return this.#enqueue(() => this.#append(draft))
	}

	/**
	 * Append a live event as its record. Resolves `undefined` for an event
	 * the log does not hold: an ephemeral one, or one bound to a turn that is
	 * paused or settled.
	 */
	async appendEvent(event: SessionEvent): Promise<SessionLogEntry | undefined> {
		if (isEphemeralEvent(event)) return undefined
		switch (event.type) {
			case 'turn_started':
				return this.begin({
					...(event.systemPrompt !== undefined ? { systemPrompt: event.systemPrompt } : {}),
					...(event.origin ? { origin: event.origin } : {}),
				})
			case 'turn_resuming':
				return this.resume(event.fromCheckpointId, event.resolvedDecisionId)
			default:
				break
		}
		if (this.#phase === 'new' || this.#phase === 'open') return undefined
		// Once the lease is given up this recorder writes nothing: an object
		// that outlived the turn (an approval-policy box, a plan manager) may
		// still emit, and its event is delivered live but not recorded.
		if (this.#released) return undefined
		const turnBound = TURN_BOUND_EVENT_TYPES.has(event.type)
		if (this.#phase === 'closed' && turnBound) return undefined
		if (this.#phase === 'paused' && turnBound) return undefined
		if (this.#ending && turnBound) return undefined
		if (event.type === 'turn_completed') {
			this.#syncMessages()
			await this.#replaceAnswerIfOverridden()
		}
		const draft = eventDraft(event, this.#turnOpen() ? this.turnId : undefined)
		this.#syncMessages()
		if (
			event.type === 'turn_paused' ||
			event.type === 'turn_completed' ||
			event.type === 'turn_failed'
		) {
			this.#ending = true
		}
		const entry = await this.#enqueue(() => this.#append(draft))
		if (event.type === 'turn_paused') this.#phase = 'paused'
		if (event.type === 'turn_completed' || event.type === 'turn_failed') this.#phase = 'closed'
		return entry
	}

	/** The turn is active and its closing record is not yet queued. */
	#turnOpen(): boolean {
		return this.#phase === 'active' && !this.#ending
	}

	/**
	 * Record a child session's lifecycle event from this session's own
	 * delegation: `child_session_spawned` inside the spawning turn, and on
	 * `child_session_idled` the idle record plus `child_session_ended`, read
	 * from the child's own terminal record so the two cannot disagree
	 * (`childLog`; absent when the child's log is not reachable, and then no
	 * ended record is written).
	 *
	 * The spawning turn's id is carried only while that turn is still open.
	 * Queued in order with every other record, so a child that settles before
	 * its parent's turn does is recorded before the parent's `turn_completed`.
	 * Resolves `undefined` for an event of another session, or once the lease
	 * is given up.
	 */
	recordChildSessionEvent(
		event: Extract<
			SessionEvent,
			{
				type: 'child_session_spawned' | 'child_session_messaged' | 'child_session_idled'
			}
		>,
		childLog?: SessionLog,
	): Promise<SessionLogEntry | undefined> {
		if (event.sessionId !== this.sessionId || this.#released) return Promise.resolve(undefined)
		if (this.#phase === 'new' || this.#phase === 'open') return Promise.resolve(undefined)
		const spawningTurnOpen = this.#turnOpen() && event.turnId === this.turnId
		if (event.type === 'child_session_spawned') {
			// Belongs to the turn that spawned it, and only while that turn is open.
			if (!spawningTurnOpen) return Promise.resolve(undefined)
			return this.appendEvent(event)
		}
		const turnId = spawningTurnOpen ? this.turnId : undefined
		this.#syncMessages()
		const idled = this.#enqueue(() => this.#append(eventDraft(event, turnId)))
		if (event.type !== 'child_session_idled' || !childLog) return idled
		return this.#enqueue(async () => {
			const ended = await childSessionEnded(childLog)
			if (!ended) return undefined
			return this.#append(turnId ? { ...ended, turnId } : ended)
		})
	}

	/**
	 * The §4.4 replacement: when an override decided the answer, the turn's
	 * last assistant message is replaced in the log (and in the context) by
	 * one whose text is the answer, before `turn_completed`.
	 */
	async #replaceAnswerIfOverridden(): Promise<void> {
		if (this.#resultSource === 'model') return
		const target = this.#lastAssistantEntry()
		const result = this.#turn.result ?? ''
		if (!target?.id) return
		const current = target.message as AssistantMessage
		if (current.content === result) return
		const targetMessageId = target.id
		const replacement: AssistantMessage = {
			...current,
			content: result,
			id: targetMessageId,
		}
		await this.#enqueue(() =>
			this.#append({
				type: 'message_replaced',
				targetMessageId,
				content: replacement,
				reason: this.#resultSource as Exclude<TurnResultSource, 'model'>,
			}),
		)
		const index = this.#turn.messages.indexOf(target.message)
		if (index >= 0) this.#turn.messages[index] = replacement
		this.#ids.delete(target.message)
		this.#ids.set(replacement, targetMessageId)
		target.message = replacement
	}

	#lastAssistantEntry(): ViewEntry | undefined {
		for (let i = this.#view.length - 1; i >= 0; i--) {
			const entry = this.#view[i]
			if (entry?.message.role === 'assistant' && entry.id) return entry
		}
		return undefined
	}

	// ─── messages ──────────────────────────────────────────────────────────

	/**
	 * Add a message to the context. A new message is appended to the log now
	 * (queued). `messageId` marks a message the log already holds (history
	 * from the fold); `transient` marks one that is never recorded.
	 */
	pushMessage(
		message: Message,
		options: {
			readonly messageId?: MessageId
			readonly transient?: boolean
		} = {},
	): void {
		if (options.messageId) {
			this.#ids.set(message, options.messageId)
			this.#recorded.set(message, options.messageId)
			stampMessageId(message, options.messageId)
		}
		if (options.transient) this.#transient.add(message)
		this.#turn.messages.push(message)
		if (options.messageId || options.transient) {
			this.#view.push({
				message,
				...(options.messageId ? { id: options.messageId } : {}),
				...(options.transient ? { transient: true } : {}),
			})
			return
		}
		this.#syncMessages()
	}

	/** Replace the context without replacing the turn; recorded as one `compaction`. */
	replaceMessages(messages: readonly Message[]): void {
		this.#turn.messages.splice(0, this.#turn.messages.length, ...messages)
		this.#syncMessages()
	}

	/**
	 * The id of the record a message was written as, or `undefined` when it
	 * has no record (yet). A message a compaction has since dropped from the
	 * fold keeps its id: its record is still in the log.
	 */
	recordedIdOf(message: Message): MessageId | undefined {
		return this.#view.find((entry) => entry.message === message)?.id ?? this.#recorded.get(message)
	}

	/** Mark a message as never recorded (the rebuilt system prompt floor). */
	markTransient(message: Message): void {
		this.#transient.add(message)
	}

	/** Messages in the context the log does not hold yet. */
	#pendingNew(): Message[] {
		const known = new Set(this.#view.map((entry) => entry.message))
		return this.#turn.messages.filter(
			(message) => !known.has(message) && !this.#transient.has(message),
		)
	}

	#idFor(message: Message): MessageId {
		let id = this.#ids.get(message)
		if (!id) {
			id = generateMessageId()
			this.#ids.set(message, id)
		}
		this.#recorded.set(message, id)
		stampMessageId(message, id)
		return id
	}

	/**
	 * Reconcile the context with the log. Nothing is written before the turn
	 * begins or after it pauses or settles.
	 */
	#syncMessages(): void {
		if (this.#phase !== 'active') return
		if (this.#rebasePending) {
			this.#rebasePending = false
			const unchanged = this.#viewMatchesFold()
			this.#foldIdsAtResume = undefined
			if (!unchanged) {
				this.#recordCompaction()
				return
			}
		}
		const live = this.#turn.messages
		const view = this.#view
		let prefix = 0
		while (prefix < view.length && prefix < live.length && live[prefix] === view[prefix]?.message)
			prefix++
		const known = new Set(view.map((entry) => entry.message))
		const tail = live.slice(prefix)
		if (prefix === view.length && tail.every((message) => !known.has(message))) {
			for (const message of tail) {
				if (this.#transient.has(message)) {
					view.push({ message, transient: true })
					continue
				}
				const id = this.#idFor(message)
				view.push({ message, id })
				void this.#enqueue(() =>
					this.#append({
						type: 'message',
						turnId: this.turnId,
						messageId: id,
						role: message.role,
						content: message,
					}),
				).catch(() => undefined)
			}
			return
		}
		this.#recordCompaction()
	}

	/**
	 * Re-base the fold on the context as it stands: one `compaction` record
	 * (new messages before the first recorded one become its summary, the
	 * recorded ones are kept), then a `message` record for each new message
	 * after the last recorded one. When the recorded messages are no longer in
	 * log order, the whole context becomes the summary.
	 */
	#recordCompaction(): void {
		const live = this.#turn.messages
		const byMessage = new Map(this.#view.map((entry) => [entry.message, entry]))
		const next: ViewEntry[] = live.map((message) => {
			const existing = byMessage.get(message)
			if (existing) return existing
			if (this.#transient.has(message)) return { message, transient: true }
			return { message }
		})
		const durable = next.filter((entry) => !entry.transient)
		const recordedOrder = new Map(
			this.#view.filter((entry) => entry.id).map((entry, index) => [entry.id as MessageId, index]),
		)
		const first = durable.findIndex((entry) => entry.id !== undefined)
		let last = -1
		for (let i = durable.length - 1; i >= 0; i--) {
			if (durable[i]?.id !== undefined) {
				last = i
				break
			}
		}
		const middle = first < 0 ? [] : durable.slice(first, last + 1)
		let ordered = middle.every((entry) => entry.id !== undefined)
		for (let i = 1; ordered && i < middle.length; i++) {
			const before = recordedOrder.get(middle[i - 1]?.id as MessageId) ?? -1
			const after = recordedOrder.get(middle[i]?.id as MessageId) ?? -1
			if (after <= before) ordered = false
		}
		const summaryEntries = !ordered ? durable : first < 0 ? durable : durable.slice(0, first)
		const keptEntries = ordered ? middle : []
		const tailEntries = ordered && first >= 0 ? durable.slice(last + 1) : []
		for (const entry of summaryEntries) {
			entry.id = undefined
			this.#ids.delete(entry.message)
			// A summary member is no longer individually recorded — a fresh
			// fold would show it with no id, so its object stops claiming one
			// too. `entry.message` is the same object `live` holds at this
			// position (built from it, above), so this is what a caller sees.
			stampMessageId(entry.message, undefined)
		}
		const summary = summaryEntries.map((entry) => entry.message)
		const keptMessageIds = keptEntries.map((entry) => entry.id as MessageId)
		this.#view = next
		const turnId = this.turnId
		void this.#enqueue(async () => {
			const toSeq = this.#lastEntry?.record.seq ?? (await this.log.head())?.pointer.seq ?? 1
			return this.#append({
				type: 'compaction',
				turnId,
				compactionId: generateMessageId(),
				strategy: 'context-rewrite',
				trigger: 'auto',
				replacesSeqRange: [1, toSeq],
				summary,
				keptMessageIds,
				tokensBefore: 0,
				tokensAfter: 0,
			})
		}).catch(() => undefined)
		for (const entry of tailEntries) {
			const message = entry.message
			const id = this.#idFor(message)
			entry.id = id
			void this.#enqueue(() =>
				this.#append({
					type: 'message',
					turnId,
					messageId: id,
					role: message.role,
					content: message,
				}),
			).catch(() => undefined)
		}
	}

	// ─── audit ─────────────────────────────────────────────────────────────

	/**
	 * Append an `audit` record. Refuses rather than dropping the entry: an
	 * audit trail nobody can point at is not a degraded feature. A rejection
	 * propagates to the caller, because an audit write failing must fail the
	 * operation it was recording.
	 */
	async recordAudit(input: AuditEventInput): Promise<AuditEvent> {
		const span = getActiveSpanContext()
		const cost = { ...this.#turn.costInfo }
		const event: AuditEvent = {
			id: generateAuditEventId(),
			sessionId: this.sessionId,
			...(this.#phase === 'active' || this.#phase === 'paused' ? { turnId: this.turnId } : {}),
			seq: this.#auditSeq + 1,
			timestamp: Date.now(),
			who: {
				agentId: this.#turn.metadata.agentId,
				tenantId: this.tenantId,
				...(input.persona !== undefined ? { persona: input.persona } : {}),
			},
			what: input.what,
			outcome: input.outcome,
			cost,
			...(input.reason !== undefined ? { reason: input.reason } : {}),
			...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
		}
		if (this.#phase === 'new' || this.#phase === 'open') {
			throw new NamzuError({
				code: 'invalid_config',
				message: 'An audit entry cannot be recorded before the turn has begun.',
				details: { sessionId: this.sessionId, turnId: this.turnId },
			})
		}
		const entry = await this.appendRecord({
			type: 'audit',
			...(event.turnId ? { turnId: event.turnId } : {}),
			auditId: event.id,
			actor: {
				kind: 'agent',
				agentId: this.#turn.metadata.agentId,
				tenantId: this.tenantId,
			},
			...(input.persona !== undefined ? { persona: input.persona } : {}),
			action: input.what.action,
			...(input.what.tool !== undefined ? { tool: input.what.tool } : {}),
			...(input.what.resource !== undefined ? { resource: input.what.resource } : {}),
			outcome: input.outcome,
			cost,
			...(input.reason !== undefined ? { reason: input.reason } : {}),
			...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
		})
		this.#auditSeq = event.seq
		this.#config.log.info('namzu.audit.written', {
			'namzu.audit.event_id': event.id,
			'namzu.audit.seq': event.seq,
			'namzu.session.record_seq': entry.record.seq,
		})
		return event
	}

	/**
	 * Wait for every queued record and flush the ledger. The durable half of
	 * settling; the terminal record itself is the `turn_completed` or
	 * `turn_failed` event.
	 */
	async persist(): Promise<void> {
		await this.budget?.flush()
		this.#syncBudget()
		this.#syncMessages()
		await this.flush()
		this.#config.log.info('Turn recorded', {
			[NAMZU.TURN_ID]: this.turnId,
			[NAMZU.SESSION_ID]: this.sessionId,
			'namzu.session.record_seq': this.lastSeq,
		})
	}

	/** Whether the turn settled with a terminal status. */
	get isTerminal(): boolean {
		return isTerminalStatus(this.#turn.status)
	}
}

/** The durable subset of the turn config `turn_started` records. */
export function snapshotTurnConfig(config: TurnRecorderConfig['turnConfig']): TurnConfigSnapshot {
	return {
		model: config.model,
		tokenBudget: config.tokenBudget,
		timeoutMs: config.timeoutMs,
		...(config.streamIdleTimeoutMs !== undefined
			? { streamIdleTimeoutMs: config.streamIdleTimeoutMs }
			: {}),
		...(config.maxRequestRichContentBytes !== undefined
			? { maxRequestRichContentBytes: config.maxRequestRichContentBytes }
			: {}),
		...(config.maxIterations !== undefined ? { maxIterations: config.maxIterations } : {}),
		...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
		...(config.maxResponseTokens !== undefined
			? { maxResponseTokens: config.maxResponseTokens }
			: {}),
		...(config.costLimitUsd !== undefined ? { costLimitUsd: config.costLimitUsd } : {}),
	}
}

/** A live event as a record draft: the payload minus the live-only fields. */
export function eventDraft(
	event: SessionEvent,
	turnId: TurnId | undefined,
): Parameters<SessionLog['append']>[1] {
	const {
		sessionId: _sessionId,
		turnId: _turnId,
		lineage: _lineage,
		v: _v,
		seq: _seq,
		generation: _generation,
		...payload
	} = event as SessionEvent & Record<string, unknown>
	const draft = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
	return { ...draft, ...(turnId ? { turnId } : {}) } as Parameters<SessionLog['append']>[1]
}

/** When `turnId` began, from its `turn_started` record; `undefined` when the log has none. */
export async function recordedTurnStart(
	log: SessionLog,
	turnId: TurnId,
): Promise<number | undefined> {
	for await (const entry of log.read()) {
		const record = entry.record as SessionRecord
		if (record.type !== 'turn_started' || record.turnId !== turnId) continue
		const at = Date.parse(record.ts)
		return Number.isFinite(at) ? at : undefined
	}
	return undefined
}

/**
 * The session's folded context with the id each message's record gave it,
 * spilled bodies read back.
 */
export async function readFoldedHistory(
	log: SessionLog,
	options: { readonly throughSeq?: number } = {},
): Promise<RecordedMessage[]> {
	const fold = new SessionMessageFold()
	for await (const entry of log.read(
		options.throughSeq !== undefined ? { throughSeq: options.throughSeq } : {},
	)) {
		fold.apply(entry.record as SessionRecord)
	}
	const out: RecordedMessage[] = []
	const spilled = fold.spilledSummary
	if (spilled) {
		// `withMessageId(message, undefined)` strips any id already embedded in
		// the spilled JSON — same as the inline branch below, and for the same
		// reason `readEverRecordedMessages`'s doc comment gives: a summary
		// member has no record of its own. A synthesized summary never had an
		// id, so this is invisible there; a fork's seeded summary IS the
		// source session's own already-id'd messages, and without this a
		// spilled (large) fork's first live turn reads its fold back carrying
		// a DIFFERENT session's ids and fails reconciliation as foreign.
		for (const message of JSON.parse(await log.readSpill(spilled.spill)) as Message[]) {
			out.push({ message: withMessageId(message, undefined) })
		}
	}
	for (const entry of fold.entries()) {
		const message = entry.spill
			? (JSON.parse(await log.readSpill(entry.spill as SpillRef)) as Message)
			: entry.message
		out.push({
			message: withMessageId(message, entry.messageId),
			...(entry.messageId ? { messageId: entry.messageId } : {}),
		})
	}
	return out
}

/**
 * Every message this session's log has ever recorded, keyed by the durable
 * id its `message` record gave it — including one a compaction has since
 * folded into a summary and dropped from {@link readFoldedHistory}'s
 * current fold. A `message_replaced` record's content wins over the message
 * it targets, the log's own precedence for "what this id means now."
 *
 * A compaction summary member has no entry here: it was never its own
 * `message` record (see {@link RecordedMessage.messageId}), so nothing can
 * recognise it by id — a caller's copy of it is reconciled by value instead.
 */
export async function readEverRecordedMessages(
	log: SessionLog,
): Promise<ReadonlyMap<MessageId, Message>> {
	const latest = new Map<MessageId, { readonly content: Message; readonly spill?: SpillRef }>()
	for await (const entry of log.read()) {
		const record = entry.record as SessionRecord
		if (record.type === 'message') {
			latest.set(record.messageId, {
				content: record.content,
				...(record.spill ? { spill: record.spill } : {}),
			})
		} else if (record.type === 'message_replaced') {
			latest.set(record.targetMessageId, {
				content: record.content,
				...(record.spill ? { spill: record.spill } : {}),
			})
		}
	}
	const resolved = new Map<MessageId, Message>()
	for (const [id, entry] of latest) {
		const content = entry.spill
			? (JSON.parse(await log.readSpill(entry.spill)) as Message)
			: entry.content
		resolved.set(id, withMessageId(content, id))
	}
	return resolved
}

/**
 * A session's audit trail: its `audit` records as {@link AuditEvent}s, in log
 * order, each numbered among the session's audit entries. What
 * `replayAudit` reads.
 */
export async function readAuditTrail(log: SessionLog): Promise<AuditEvent[]> {
	const trail: AuditEvent[] = []
	for await (const { record } of log.read()) {
		if (record.type !== 'audit') continue
		const actor = record.actor
		trail.push({
			id: record.auditId as AuditEvent['id'],
			sessionId: record.sessionId,
			...(record.turnId !== undefined ? { turnId: record.turnId } : {}),
			seq: trail.length + 1,
			timestamp: Date.parse(record.ts),
			who: {
				agentId: actor.kind === 'agent' ? actor.agentId : actor.kind,
				tenantId: actor.tenantId,
				...(record.persona !== undefined ? { persona: record.persona } : {}),
			},
			what: {
				action: record.action,
				...(record.tool !== undefined ? { tool: record.tool } : {}),
				...(record.resource !== undefined ? { resource: record.resource } : {}),
			},
			outcome: record.outcome,
			cost: record.cost ?? { ...ZERO_COST },
			...(record.reason !== undefined ? { reason: record.reason } : {}),
			...(record.traceId !== undefined ? { traceId: record.traceId } : {}),
			...(record.spanId !== undefined ? { spanId: record.spanId } : {}),
		})
	}
	return trail
}
