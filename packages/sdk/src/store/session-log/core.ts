import {
	SessionLogLineError,
	formatSessionLogLine,
	parseSessionLogLine,
} from '../../session/log-hash.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import {
	type RecordPointer,
	SESSION_RECORD_MAX_BYTES,
	SESSION_RECORD_SCHEMA_VERSION,
	type SessionRecord,
	SessionRecordSchema,
} from '../../types/session/records.js'
import {
	type ActiveTurnState,
	TurnInProgressError,
	type TurnSettlement,
} from '../../types/session/turn.js'
import { generateRecordId } from '../../utils/id.js'
import {
	LineSplitter,
	type LogBytes,
	SessionLogChain,
	type SessionLogEntry,
	SessionLogIntegrityError,
	verifyPointer,
} from './chain.js'
import {
	type ActiveTurnRecord,
	SessionTurnState,
	TurnRuleError,
	foldSessionMessages,
} from './fold.js'
import { repairRecordDraft } from './heal.js'
import {
	type ClaimSessionOptions,
	type SessionLease,
	type SessionLeaseStore,
	StaleSessionLeaseError,
	isLeaseLive,
} from './lease.js'
import type { SpillRef, SpillStore } from './spill.js'

// ─── public types ─────────────────────────────────────────────────────────

type EnvelopeKey = 'v' | 'id' | 'sessionId' | 'seq' | 'ts' | 'prev' | 'prevText' | 'gen'

type DraftOf<R> = R extends SessionRecord ? Omit<R, EnvelopeKey> : never

/**
 * A record as a caller appends it: everything but the envelope. The log
 * assigns `v`, `id`, `sessionId`, `seq`, `ts`, `prev` and `gen`; the caller
 * gives the `type`, the payload and, inside a turn, the `turnId`.
 */
export type SessionRecordDraft = DraftOf<SessionRecord>

/** The payload of a `turn_started` record, as `beginTurn` takes it. */
export type TurnStartedDraft = Omit<Extract<SessionRecordDraft, { type: 'turn_started' }>, 'type'>

/** The last record of a log and the log's size in bytes. */
export interface SessionLogHead {
	readonly pointer: RecordPointer
	readonly gen: number
	/** Bytes of the log through the head record (a torn tail is not counted). */
	readonly bytes: number
}

/** A session's active turn and its state (spec §4.5). */
export interface ActiveTurn extends ActiveTurnRecord {
	readonly state: ActiveTurnState
}

export interface ReadSessionLogOptions {
	/**
	 * `strict` (the default) throws {@link SessionLogIntegrityError} at the
	 * first break. `tolerant` stops there and reports `intact: false` with
	 * everything before the break.
	 */
	readonly mode?: 'strict' | 'tolerant'
	/** Resume after this record: its bytes are checked, then the walk continues from it. */
	readonly after?: RecordPointer
	/**
	 * The record the log must hold at `expectHead.seq`, byte for byte. Anchors
	 * the tail, which no later record vouches for.
	 */
	readonly expectHead?: RecordPointer
	/** Stop after this seq. */
	readonly throughSeq?: number
}

/** What a read established, returned when the walk ends. */
export interface SessionLogReadSummary {
	/** False when a tolerant read stopped at a break. */
	readonly intact: boolean
	/** The last seq read and verified (0 for an empty log). */
	readonly throughSeq: number
	readonly head: SessionLogHead | null
	/** Bytes after the last complete line: a torn tail, which a writer truncates. */
	readonly tornBytes: number
	/** The break a tolerant read stopped at. */
	readonly break?: SessionLogIntegrityError
}

export interface SessionLogRead extends SessionLogReadSummary {
	readonly entries: readonly SessionLogEntry[]
}

export interface BeginTurnOptions {
	/**
	 * Close an `interrupted` active turn with `turn_failed{failure.code:
	 * 'interrupted'}` before beginning. A `running` or `paused` turn is never
	 * closed this way.
	 */
	readonly abandonInterrupted?: boolean
}

export interface ActiveTurnOptions {
	/** The lease the caller holds; the default asks the store for the current one. */
	readonly lease?: SessionLease
	/** Clock, for tests. */
	readonly now?: number
}

/**
 * One session's append-only, hash-chained log: the source of truth for
 * everything the session did (spec §4). One writer at a time holds its
 * lease; every append presents it.
 */
export interface SessionLog {
	readonly sessionId: SessionId

	/**
	 * Take or renew the writer lease. `null` when it is live and this instance
	 * does not hold it — whatever the holder name, so a second instance under
	 * the same name waits like any other. This instance renews its own holding
	 * under the same fence, late or not, unless somebody took the session in
	 * between. A new fence is above the log's highest `gen`. Taking it
	 * repairs a torn tail first (`log_repaired`).
	 */
	claim(options: ClaimSessionOptions): Promise<SessionLease | null>
	/** Give the lease up; a stale lease releases nothing. */
	release(lease: SessionLease): Promise<void>
	/** The current holding, or `null` when never claimed. */
	lease(): Promise<SessionLease | null>

	/**
	 * Append one record under `lease`. Refused with
	 * {@link StaleSessionLeaseError} when the lease is not the current one,
	 * {@link TurnRuleError} when the turn rules forbid the record, and
	 * {@link InvalidSessionRecordError} when it is not a valid record. A body
	 * too large for a record is spilled first.
	 */
	append(lease: SessionLease, draft: SessionRecordDraft): Promise<SessionLogEntry>
	/**
	 * Begin a turn. Throws {@link TurnInProgressError} when a turn is active
	 * (`running`, `paused` or `interrupted`), unless it is `interrupted` and
	 * `abandonInterrupted` is set.
	 */
	beginTurn(
		lease: SessionLease,
		draft: TurnStartedDraft,
		options?: BeginTurnOptions,
	): Promise<SessionLogEntry>
	/** Close a paused or interrupted turn with `turn_failed{failure.code:'abandoned'}`. */
	abandonTurn(lease: SessionLease, turnId: TurnId, reason: string): Promise<SessionLogEntry>
	/** The active turn, if any, and whether it is running, paused or interrupted. */
	activeTurn(options?: ActiveTurnOptions): Promise<ActiveTurn | null>

	head(): Promise<SessionLogHead | null>
	/** Walk the log, verifying the chain. Returns the summary when the walk ends. */
	read(options?: ReadSessionLogOptions): AsyncGenerator<SessionLogEntry, SessionLogReadSummary>
	readAll(options?: ReadSessionLogOptions): Promise<SessionLogRead>
	/** The folded conversation (spec §4.5), spills read back. */
	messages(options?: { readonly throughSeq?: number }): Promise<Message[]>
	readSpill(ref: SpillRef): Promise<string>
}

/** A draft that is not a valid session record once enveloped. */
export class InvalidSessionRecordError extends Error {
	override readonly name = 'InvalidSessionRecordError'
}

/** The log changed under a writer in a way it cannot reconcile (a concurrent writer). */
export class SessionLogConflictError extends Error {
	override readonly name = 'SessionLogConflictError'
}

// ─── the medium ───────────────────────────────────────────────────────────

/** The bytes of one log, as the disk and in-memory backends store them. */
export interface LogMedium extends LogBytes {
	/**
	 * Append `bytes` so they start at `expectedOffset`. Throws
	 * {@link SessionLogConflictError} if the log is not `expectedOffset` long
	 * when the write is issued, or if the bytes did not land there.
	 */
	append(bytes: Uint8Array, expectedOffset: number, sync: boolean): Promise<void>
	/** Cut the log to `size` bytes, durably. Refuses if it is not `expectedSize` long. */
	truncate(size: number, expectedSize: number): Promise<void>
	/** The bytes from `offset` to the end, in chunks. */
	stream(offset: number): AsyncIterable<Uint8Array>
}

export interface SessionLogCoreOptions {
	readonly sessionId: SessionId
	readonly medium: LogMedium
	readonly leases: SessionLeaseStore
	readonly spills: SpillStore
	/** Clock for `ts` and turn timings. */
	readonly now?: () => number
	/**
	 * A `message` or `compaction` record whose line would exceed this many
	 * bytes spills its body first. Default {@link SESSION_RECORD_MAX_BYTES}.
	 */
	readonly spillAboveBytes?: number
	/**
	 * Which appends are fsynced. `boundaries` (the default): the records
	 * others depend on — `session_started`, the turn lifecycle, checkpoints
	 * and decisions. `all` or `none` as named.
	 */
	readonly sync?: 'boundaries' | 'all' | 'none'
}

const BOUNDARY_TYPES: ReadonlySet<string> = new Set([
	'session_started',
	'turn_started',
	'turn_paused',
	'turn_resuming',
	'turn_completed',
	'turn_failed',
	'checkpoint_written',
	'decision_requested',
	'decision_resolved',
	'decision_expired',
	'log_repaired',
])

/** Characters of a spilled message kept inline as its preview. */
const PREVIEW_CHARS = 2000

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}
const ZERO_COST = { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 }

/** Serialises a log's writes within one instance. */
class Mutex {
	#tail: Promise<void> = Promise.resolve()
	run<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation)
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}
}

/**
 * The log's behaviour, shared by both backends so they cannot disagree. A
 * backend supplies the medium, the lease store and the spill store.
 */
export class SessionLogCore implements SessionLog {
	readonly sessionId: SessionId
	readonly #medium: LogMedium
	readonly #leases: SessionLeaseStore
	readonly #spills: SpillStore
	readonly #now: () => number
	readonly #spillAbove: number
	readonly #sync: 'boundaries' | 'all' | 'none'
	readonly #mutex = new Mutex()

	#chain = new SessionLogChain()
	#turns = new SessionTurnState()
	/** The holding this instance took, which it presents to renew. */
	#held: SessionLease | undefined
	/** Bytes of the log this instance has verified and applied. */
	#synced = 0
	#torn = 0

	constructor(options: SessionLogCoreOptions) {
		this.sessionId = options.sessionId
		this.#medium = options.medium
		this.#leases = options.leases
		this.#spills = options.spills
		this.#now = options.now ?? Date.now
		this.#spillAbove = Math.min(
			options.spillAboveBytes ?? SESSION_RECORD_MAX_BYTES,
			SESSION_RECORD_MAX_BYTES,
		)
		this.#sync = options.sync ?? 'boundaries'
	}

	// ── state ──

	/** Catch up with the medium: verify and apply whatever was appended since the last sync. */
	async #catchUp(): Promise<void> {
		const size = await this.#medium.size()
		if (size === this.#synced + this.#torn && size >= this.#synced) return
		if (size < this.#synced) this.#reset()
		const splitter = new LineSplitter(this.#synced)
		for await (const chunk of this.#medium.stream(this.#synced)) {
			for (const { line, offset } of splitter.push(chunk)) {
				const entry = this.#chain.accept(line, offset)
				if (this.#chain.sessionId !== this.sessionId) {
					throw new SessionLogIntegrityError(
						'session-mismatch',
						entry.pointer.seq,
						offset,
						`The log belongs to session ${this.#chain.sessionId}, not ${this.sessionId}.`,
					)
				}
				this.#turns.apply(entry.record)
				this.#synced = offset + line.byteLength
			}
		}
		this.#torn = splitter.pendingBytes
	}

	#reset(): void {
		this.#chain = new SessionLogChain()
		this.#turns = new SessionTurnState()
		this.#synced = 0
		this.#torn = 0
	}

	async #requireCurrent(lease: SessionLease): Promise<void> {
		const fence = await this.#leases.fence()
		if (lease.fence !== fence) {
			const current = await this.#leases.current()
			throw new StaleSessionLeaseError(lease.fence, fence, current?.holder)
		}
	}

	/** Truncate a torn tail and record the repair. Caller holds the mutex and a current lease. */
	async #heal(lease: SessionLease): Promise<void> {
		if (this.#torn === 0) return
		const truncated = this.#torn
		await this.#medium.truncate(this.#synced, this.#synced + this.#torn)
		this.#torn = 0
		const draft = repairRecordDraft({
			truncatedBytes: truncated,
			lastGoodSeq: this.#chain.head?.seq ?? 0,
			activeTurnId: this.#turns.active?.turnId,
		})
		if (draft !== undefined) await this.#write(lease, draft)
	}

	// ── lease ──

	async claim(options: ClaimSessionOptions): Promise<SessionLease | null> {
		// The log's own highest gen is the floor for a new fence, so lease files
		// that were lost or cleared cannot mint a fence below records already
		// written. A log that cannot be read is refused below, after the claim,
		// so that the refusal releases what it took.
		const above = await this.#mutex.run(async () => {
			await this.#catchUp().catch(() => undefined)
			return this.#chain.gen
		})
		// Renewal presents the holding this instance has; a name alone never renews.
		const lease = await this.#leases.claim(options, { renew: this.#held, above })
		if (lease === null) return null
		this.#held = lease
		try {
			await this.#mutex.run(async () => {
				await this.#catchUp()
				await this.#heal(lease)
			})
		} catch (error) {
			// A log this writer cannot append to (a broken chain, a conflict) is
			// not held: the next taker gets the same refusal instead of a wait.
			this.#held = undefined
			await this.#leases.release(lease).catch(() => undefined)
			throw error
		}
		return lease
	}

	release(lease: SessionLease): Promise<void> {
		if (this.#held?.fence === lease.fence) this.#held = undefined
		return this.#leases.release(lease)
	}

	lease(): Promise<SessionLease | null> {
		return this.#leases.current()
	}

	// ── writes ──

	append(lease: SessionLease, draft: SessionRecordDraft): Promise<SessionLogEntry> {
		return this.#mutex.run(async () => {
			await this.#requireCurrent(lease)
			await this.#catchUp()
			await this.#heal(lease)
			if (draft.type === 'turn_started') {
				throw new TurnRuleError('Begin a turn with beginTurn, which enforces one active turn.')
			}
			this.#checkOwnership(lease, draft)
			return this.#write(lease, draft)
		})
	}

	/**
	 * Records of an interrupted turn — one whose owner lease is gone — are
	 * refused until it is resumed or closed: a new holder does not silently
	 * continue a dead process's turn.
	 */
	#checkOwnership(lease: SessionLease, draft: SessionRecordDraft): void {
		const active = this.#turns.active
		if (active === undefined || draft.turnId !== active.turnId || active.paused) return
		if (active.ownerGen === lease.fence) return
		if (
			draft.type === 'turn_resuming' ||
			draft.type === 'turn_failed' ||
			draft.type === 'turn_completed'
		) {
			return
		}
		throw new TurnRuleError(
			`Turn ${active.turnId} was started under lease fence ${active.ownerGen} and is interrupted; resume it (turn_resuming) or close it before appending to it.`,
		)
	}

	beginTurn(
		lease: SessionLease,
		draft: TurnStartedDraft,
		options: BeginTurnOptions = {},
	): Promise<SessionLogEntry> {
		return this.#mutex.run(async () => {
			await this.#requireCurrent(lease)
			await this.#catchUp()
			await this.#heal(lease)
			const active = this.#turns.active
			if (active !== undefined) {
				const state = this.#stateFor(active, lease.fence)
				if (state !== 'interrupted' || !options.abandonInterrupted) {
					throw new TurnInProgressError({
						sessionId: this.sessionId,
						activeTurnId: active.turnId,
						state,
					})
				}
				await this.#write(
					lease,
					this.#failedDraft(
						active,
						'interrupted',
						'The process running this turn is gone; the turn was closed before the next one began.',
					),
				)
			}
			return this.#write(lease, { type: 'turn_started', ...draft } as SessionRecordDraft)
		})
	}

	abandonTurn(lease: SessionLease, turnId: TurnId, reason: string): Promise<SessionLogEntry> {
		return this.#mutex.run(async () => {
			await this.#requireCurrent(lease)
			await this.#catchUp()
			await this.#heal(lease)
			const active = this.#turns.active
			if (active === undefined || active.turnId !== turnId) {
				throw new TurnRuleError(`Turn ${turnId} is not this session's active turn.`)
			}
			const state = this.#stateFor(active, lease.fence)
			if (state === 'running') {
				throw new TurnInProgressError({ sessionId: this.sessionId, activeTurnId: turnId, state })
			}
			return this.#write(lease, this.#failedDraft(active, 'abandoned', reason))
		})
	}

	#stateFor(active: ActiveTurnRecord, fence: number): ActiveTurnState {
		if (active.paused) return 'paused'
		return active.ownerGen === fence ? 'running' : 'interrupted'
	}

	#failedDraft(active: ActiveTurnRecord, code: string, message: string): SessionRecordDraft {
		const settlement: TurnSettlement = {
			status: 'failed',
			iterations: 0,
			usage: ZERO_USAGE,
			cost: ZERO_COST,
			durationMs: Math.max(0, this.#now() - Date.parse(active.startedAt)),
			resultSource: 'model',
			abandonedTaskIds: [],
			abandonedJobIds: [],
		}
		return {
			type: 'turn_failed',
			turnId: active.turnId,
			error: message,
			failure: { code, message, retryable: false },
			settlement,
		} as SessionRecordDraft
	}

	/** Envelope, spill, validate, check the turn rules, write. Caller holds the mutex. */
	async #write(lease: SessionLease, draft: SessionRecordDraft): Promise<SessionLogEntry> {
		// The chain would refuse a regressed gen only after the bytes landed,
		// leaving a line no reader accepts; refuse it before writing
		// anything, a spill included.
		if (lease.fence < this.#chain.gen) {
			throw new StaleSessionLeaseError(lease.fence, this.#chain.gen)
		}
		const head = this.#chain.head
		const envelope = {
			v: SESSION_RECORD_SCHEMA_VERSION,
			id: generateRecordId(),
			sessionId: this.sessionId,
			seq: (head?.seq ?? 0) + 1,
			ts: new Date(this.#now()).toISOString(),
			prev: head,
			gen: lease.fence,
		}
		const { type, ...payload } = draft as { type: string } & Record<string, unknown>
		let candidate: Record<string, unknown> = { ...envelope, type, ...payload }
		candidate = await this.#spillIfLarge(candidate)
		const parsed = SessionRecordSchema.safeParse(candidate)
		if (!parsed.success) {
			throw new InvalidSessionRecordError(
				`A ${type} record is not a valid session record: ${parsed.error.issues
					.map((issue) => `${issue.path.join('.') || '(record)'}: ${issue.message}`)
					.join('; ')}`,
			)
		}
		// The candidate, not the parse output: zod may reorder or drop nothing
		// here (every schema is strict), and the bytes hashed are the bytes written.
		const record = candidate as unknown as SessionRecord
		this.#turns.check(record)
		let line: string
		try {
			line = formatSessionLogLine(record)
		} catch (error) {
			throw new InvalidSessionRecordError(
				error instanceof SessionLogLineError ? error.message : String(error),
			)
		}
		const bytes = Buffer.from(line, 'utf8')
		const sync = this.#sync === 'all' || (this.#sync === 'boundaries' && BOUNDARY_TYPES.has(type))
		await this.#medium.append(bytes, this.#synced, sync)
		const entry = this.#chain.accept(bytes, this.#synced)
		this.#turns.apply(entry.record)
		this.#synced += bytes.byteLength
		return entry
	}

	async #spillIfLarge(candidate: Record<string, unknown>): Promise<Record<string, unknown>> {
		const type = candidate.type
		if (
			type !== 'message' &&
			type !== 'message_replaced' &&
			type !== 'compaction' &&
			type !== 'turn_completed'
		)
			return candidate
		const size = Buffer.byteLength(`${JSON.stringify(candidate)}\n`, 'utf8')
		if (size <= this.#spillAbove) return candidate
		if (type === 'turn_completed') {
			if (typeof candidate.result !== 'string') return candidate
			const ref = await this.#spills.write(
				`record:${String(candidate.id)}`,
				'message',
				candidate.result,
			)
			const preview = `${candidate.result.slice(0, PREVIEW_CHARS)}\n[… ${ref.bytes} bytes spilled to ${ref.path}]`
			return { ...candidate, result: preview, resultSpill: ref }
		}
		if (candidate.type === 'compaction') {
			if (!Array.isArray(candidate.summary)) return candidate
			const ref = await this.#spills.write(
				`compaction:${String(candidate.compactionId)}`,
				'messages',
				JSON.stringify(candidate.summary),
			)
			return { ...candidate, summary: ref }
		}
		const content = candidate.content as Message & { toolCallId?: unknown }
		const key =
			content.role === 'tool' && typeof content.toolCallId === 'string'
				? content.toolCallId
				: type === 'message_replaced'
					? `record:${String(candidate.id)}`
					: `message:${String(candidate.messageId)}`
		const ref = await this.#spills.write(key, 'message', JSON.stringify(content))
		const text =
			typeof content.content === 'string' ? content.content : JSON.stringify(content.content)
		const preview = {
			role: content.role,
			content: `${text.slice(0, PREVIEW_CHARS)}\n[… ${ref.bytes} bytes spilled to ${ref.path}]`,
			...(typeof content.toolCallId === 'string' ? { toolCallId: content.toolCallId } : {}),
		}
		return { ...candidate, content: preview, spill: ref }
	}

	// ── reads ──

	activeTurn(options: ActiveTurnOptions = {}): Promise<ActiveTurn | null> {
		return this.#mutex.run(async () => {
			await this.#catchUp()
			const active = this.#turns.active
			if (active === undefined) return null
			if (active.paused) return { ...active, state: 'paused' }
			const now = options.now ?? this.#now()
			const lease = options.lease ?? (await this.#leases.current())
			const live = options.lease !== undefined || isLeaseLive(lease, now)
			const state: ActiveTurnState =
				live && lease !== null && lease.fence === active.ownerGen ? 'running' : 'interrupted'
			return { ...active, state }
		})
	}

	head(): Promise<SessionLogHead | null> {
		return this.#mutex.run(async () => {
			await this.#catchUp()
			const pointer = this.#chain.head
			if (pointer === null) return null
			return { pointer, gen: this.#chain.gen, bytes: this.#synced }
		})
	}

	read(
		options: ReadSessionLogOptions = {},
	): AsyncGenerator<SessionLogEntry, SessionLogReadSummary> {
		return walkSessionLog(this.#medium, { ...options, sessionId: this.sessionId })
	}

	async readAll(options: ReadSessionLogOptions = {}): Promise<SessionLogRead> {
		return collect(this.read(options))
	}

	async messages(options: { readonly throughSeq?: number } = {}): Promise<Message[]> {
		const log = this
		async function* records(): AsyncGenerator<SessionRecord> {
			for await (const entry of log.read({ throughSeq: options.throughSeq })) yield entry.record
		}
		return foldSessionMessages(records(), {
			throughSeq: options.throughSeq,
			readSpill: (ref) => this.#spills.read(ref),
		})
	}

	readSpill(ref: SpillRef): Promise<string> {
		return this.#spills.read(ref)
	}
}

/** Drain a walk into entries plus its summary. */
export async function collect(
	walk: AsyncGenerator<SessionLogEntry, SessionLogReadSummary>,
): Promise<SessionLogRead> {
	const entries: SessionLogEntry[] = []
	for (;;) {
		const step = await walk.next()
		if (step.done) return { ...step.value, entries }
		entries.push(step.value)
	}
}

/**
 * Walk a log's bytes, verifying the chain as it goes (spec §4.1). Shared by
 * both backends and by `readSessionLog`.
 */
export async function* walkSessionLog(
	medium: Pick<LogMedium, 'size' | 'read' | 'stream'>,
	options: ReadSessionLogOptions & { readonly sessionId?: SessionId },
): AsyncGenerator<SessionLogEntry, SessionLogReadSummary> {
	const strict = (options.mode ?? 'strict') === 'strict'
	let chain: SessionLogChain
	let start = 0
	let brokeAt: SessionLogIntegrityError | undefined
	const fail = (error: SessionLogIntegrityError): void => {
		if (strict) throw error
		brokeAt = error
	}

	if (options.after !== undefined) {
		const after = options.after
		if (!(await verifyPointer(medium, after))) {
			const error = new SessionLogIntegrityError(
				'anchor-mismatch',
				after.seq,
				after.offset,
				`The log does not hold the record the cursor names (seq ${after.seq} at byte ${after.offset}).`,
			)
			fail(error)
			return { intact: false, throughSeq: 0, head: null, tornBytes: 0, break: error }
		}
		const parsed = parseSessionLogLine(await medium.read(after.offset, after.length))
		chain = new SessionLogChain({
			head: after,
			sessionId: options.sessionId ?? parsed.record.sessionId,
			gen: parsed.record.gen,
		})
		start = after.offset + after.length
	} else {
		chain = new SessionLogChain({ head: null, sessionId: options.sessionId })
	}

	const splitter = new LineSplitter(start)
	let anchorSeen = false
	let stopped = false
	outer: for await (const chunk of medium.stream(start)) {
		let lines: Generator<{ line: Uint8Array; offset: number }>
		try {
			lines = splitter.push(chunk)
			for (const { line, offset } of lines) {
				let entry: SessionLogEntry
				try {
					entry = chain.accept(line, offset)
				} catch (error) {
					if (!(error instanceof SessionLogIntegrityError)) throw error
					fail(error)
					stopped = true
					break outer
				}
				if (options.expectHead !== undefined && entry.pointer.seq === options.expectHead.seq) {
					anchorSeen = true
					const e = options.expectHead
					if (
						e.offset !== entry.pointer.offset ||
						e.length !== entry.pointer.length ||
						e.sha256 !== entry.pointer.sha256
					) {
						fail(
							new SessionLogIntegrityError(
								'anchor-mismatch',
								e.seq,
								entry.pointer.offset,
								`The record at seq ${e.seq} is not the one the anchor names; the log was altered.`,
							),
						)
						stopped = true
						break outer
					}
				}
				yield entry
				if (options.throughSeq !== undefined && entry.pointer.seq >= options.throughSeq) {
					stopped = true
					break outer
				}
			}
		} catch (error) {
			if (!(error instanceof SessionLogIntegrityError)) throw error
			fail(error)
			stopped = true
			break
		}
	}
	if (!stopped && options.expectHead !== undefined && !anchorSeen && brokeAt === undefined) {
		const e = options.expectHead
		fail(
			new SessionLogIntegrityError(
				'anchor-mismatch',
				e.seq,
				chain.end,
				`The log ends at seq ${chain.head?.seq ?? 0}, before the anchored seq ${e.seq}; it was truncated.`,
			),
		)
	}
	const pointer = chain.head
	return {
		intact: brokeAt === undefined,
		throughSeq: pointer?.seq ?? 0,
		head: pointer === null ? null : { pointer, gen: chain.gen, bytes: chain.end },
		tornBytes: stopped ? 0 : splitter.pendingBytes,
		...(brokeAt === undefined ? {} : { break: brokeAt }),
	}
}
