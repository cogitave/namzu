import type { CheckpointId, MessageId, TurnId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import type { CompactionRecord, MessageRecord, SessionRecord } from '../../types/session/records.js'
import type { SpillRef } from './spill.js'

/**
 * Folds over a session log's records: the conversation a model sees, and
 * which turn (if any) is active.
 *
 * ## The message fold (spec §4.5)
 *
 * The context is, in order:
 *
 * 1. the latest `compaction`'s summary;
 * 2. then the messages it kept (`keptMessageIds`, plus any `pinned`);
 * 3. then every message after its `replacesSeqRange`;
 * 4. with every `message_replaced` applied.
 *
 * A replacement changes a message's content in place and keeps its id and
 * position. It applies whenever its target is in the context, including a
 * target that a compaction keeps. So a guardrail's rewrite, a review's
 * override or a structured-output answer is what every reader of the fold
 * sees; the model's raw text stays in the log for audit only.
 *
 * Only `message`, `message_replaced` and `compaction` records move the fold.
 * The live compaction events (`compaction_completed` and the rest) are
 * reports, not instructions.
 */

/** One message of the folded context. */
export interface FoldedMessage {
	/** Absent for a compaction summary message, which has no record of its own. */
	readonly messageId?: MessageId
	/** Seq of the record that put the message in the log (the compaction's, for a summary). */
	readonly seq: number
	readonly message: Message
	/** Set when the record's content is a preview and the full message is in a spill. */
	readonly spill?: SpillRef
	/** Set when a `message_replaced` changed this message. */
	readonly replacedAtSeq?: number
}

interface Slot {
	messageId?: MessageId
	seq: number
	message: Message
	spill?: SpillRef
	replacedAtSeq?: number
}

/** A compaction whose summary was spilled; the fold resolves it on demand. */
export interface SpilledSummary {
	readonly seq: number
	readonly spill: SpillRef
}

/**
 * The message fold, applied one record at a time.
 *
 * Synchronous and pure: spilled bodies are left as references
 * ({@link FoldedMessage.spill}, {@link SessionMessageFold.spilledSummary});
 * {@link foldSessionMessages} resolves them.
 */
export class SessionMessageFold {
	#slots: Slot[] = []
	readonly #byId = new Map<string, Slot>()
	/**
	 * The latest replacement of every message id, whether or not its target
	 * was in the context when it was applied. Kept for good: a later record of
	 * the same message must not bring the replaced (raw) content back (§4.4).
	 */
	readonly #replacements = new Map<string, { message: Message; seq: number; spill?: SpillRef }>()
	#spilledSummary: SpilledSummary | undefined

	/** Seq of the last record applied. */
	#throughSeq = 0

	get throughSeq(): number {
		return this.#throughSeq
	}

	get spilledSummary(): SpilledSummary | undefined {
		return this.#spilledSummary
	}

	apply(record: SessionRecord): void {
		this.#throughSeq = record.seq
		switch (record.type) {
			case 'message':
				this.#message(record as MessageRecord)
				return
			case 'message_replaced': {
				const spill = (record as { spill?: SpillRef }).spill
				this.#replacements.set(record.targetMessageId, {
					message: record.content,
					seq: record.seq,
					...(spill === undefined ? {} : { spill }),
				})
				const slot = this.#byId.get(record.targetMessageId)
				if (slot === undefined) return
				slot.message = record.content
				slot.replacedAtSeq = record.seq
				// The target's own spill no longer applies; a replacement too large
				// for its record carries its own.
				slot.spill = spill
				return
			}
			case 'compaction':
				this.#compaction(record as CompactionRecord)
				return
			default:
				return
		}
	}

	#message(record: MessageRecord): void {
		const replaced = this.#replacements.get(record.messageId)
		const existing = this.#byId.get(record.messageId)
		const slot: Slot = {
			messageId: record.messageId,
			seq: record.seq,
			message: replaced?.message ?? record.content,
			...(replaced !== undefined
				? replaced.spill === undefined
					? {}
					: { spill: replaced.spill }
				: record.spill === undefined
					? {}
					: { spill: record.spill }),
			...(replaced === undefined ? {} : { replacedAtSeq: replaced.seq }),
		}
		if (existing !== undefined) {
			// The same message recorded twice is one message; the later record
			// wins in place, except over a replacement, which outranks every
			// record of its target.
			existing.seq = slot.seq
			existing.message = slot.message
			existing.spill = slot.spill
			existing.replacedAtSeq = slot.replacedAtSeq
			return
		}
		this.#slots.push(slot)
		this.#byId.set(record.messageId, slot)
	}

	#compaction(record: CompactionRecord): void {
		const [, toSeq] = record.replacesSeqRange
		const keep = new Set<string>([...record.keptMessageIds, ...(record.pinned ?? [])])
		const summary: Slot[] = Array.isArray(record.summary)
			? record.summary.map((message) => ({ seq: record.seq, message }))
			: []
		this.#spilledSummary = Array.isArray(record.summary)
			? undefined
			: { seq: record.seq, spill: record.summary }
		const kept = this.#slots.filter(
			(slot) => slot.messageId !== undefined && keep.has(slot.messageId),
		)
		const after = this.#slots.filter(
			(slot) =>
				slot.messageId !== undefined && slot.seq > toSeq && !keep.has(slot.messageId as string),
		)
		this.#slots = [...summary, ...kept, ...after]
		this.#byId.clear()
		for (const slot of this.#slots) {
			if (slot.messageId !== undefined) this.#byId.set(slot.messageId, slot)
		}
	}

	/** The folded context, oldest first. A spilled summary is not included; see {@link foldSessionMessages}. */
	entries(): FoldedMessage[] {
		return this.#slots.map((slot) => ({ ...slot }))
	}

	messages(): Message[] {
		return this.#slots.map((slot) => slot.message)
	}
}

export interface FoldSessionMessagesOptions {
	/** Fold only records with `seq <= throughSeq` (a checkpoint's context). */
	readonly throughSeq?: number
	/** Reads a spilled body. Required when the log holds a spill; the fold refuses without it. */
	readonly readSpill?: (ref: SpillRef) => Promise<string>
}

/** A spill the fold met with no way to read it. */
export class SpillUnavailableError extends Error {
	override readonly name = 'SpillUnavailableError'
}

function spillMissing(ref: SpillRef): never {
	throw new SpillUnavailableError(
		`The session log references spilled content at ${ref.path}, and no spill reader was given.`,
	)
}

/**
 * The conversation a session log holds: the fold of every record (or of the
 * records through `throughSeq`), spilled bodies read back and checked.
 */
export async function foldSessionMessages(
	records: Iterable<SessionRecord> | AsyncIterable<SessionRecord>,
	options: FoldSessionMessagesOptions = {},
): Promise<Message[]> {
	const fold = new SessionMessageFold()
	for await (const record of records) {
		if (options.throughSeq !== undefined && record.seq > options.throughSeq) break
		fold.apply(record)
	}
	const out: Message[] = []
	const spilled = fold.spilledSummary
	if (spilled !== undefined) {
		const text = await (options.readSpill ?? spillMissing)(spilled.spill)
		out.push(...(JSON.parse(text) as Message[]))
	}
	for (const entry of fold.entries()) {
		if (entry.spill === undefined) {
			out.push(entry.message)
			continue
		}
		const text = await (options.readSpill ?? spillMissing)(entry.spill)
		out.push(JSON.parse(text) as Message)
	}
	return out
}

// ─── turn state ───────────────────────────────────────────────────────────

/** The active turn as the log records it, before any lease is consulted. */
export interface ActiveTurnRecord {
	readonly turnId: TurnId
	/** Seq of its `turn_started`. */
	readonly startedSeq: number
	readonly startedAt: string
	/** Set while its last segment record is `turn_paused`. */
	readonly paused: boolean
	readonly pausedCheckpointId?: CheckpointId
	/**
	 * The `gen` of its latest `turn_started` or `turn_resuming`: the lease
	 * holding that is running it. A lease at a higher fence did not start it.
	 */
	readonly ownerGen: number
}

/** A record that the turn rules refuse at append time. */
export class TurnRuleError extends Error {
	override readonly name = 'TurnRuleError'
}

/**
 * Tracks the session's one active turn (spec §4.5), record by record.
 *
 * `apply` in strict mode throws {@link TurnRuleError} for a record the turn
 * rules forbid — the writer uses it to refuse an append before it is written.
 * A reader applies records tolerantly: what is in the log is what happened.
 */
export class SessionTurnState {
	#active: ActiveTurnRecord | undefined
	#lastTurnId: TurnId | undefined
	#started = false

	get active(): ActiveTurnRecord | undefined {
		return this.#active
	}

	/** The last turn that started, active or not. */
	get lastTurnId(): TurnId | undefined {
		return this.#lastTurnId
	}

	/** Whether `session_started` has been applied. */
	get started(): boolean {
		return this.#started
	}

	/** Throws {@link TurnRuleError} if `record` may not follow the records applied so far. */
	check(record: Pick<SessionRecord, 'type' | 'turnId'>): void {
		const active = this.#active
		const refuse = (message: string): never => {
			throw new TurnRuleError(message)
		}
		if (record.type === 'session_started') {
			if (this.#started) refuse('session_started is the first record of a log, and only the first')
			return
		}
		if (!this.#started) refuse('the first record of a log is session_started')
		if (record.type === 'turn_started') {
			if (active !== undefined) {
				refuse(`turn ${active.turnId} is still active; a session has one active turn at a time`)
			}
			return
		}
		if (record.turnId === undefined) return
		if (active === undefined) {
			refuse(`the record names turn ${record.turnId}, and no turn is active`)
		}
		const current = active as ActiveTurnRecord
		if (record.turnId !== current.turnId) {
			refuse(`the record names turn ${record.turnId}; the active turn is ${current.turnId}`)
		}
		if (record.type === 'turn_resuming' && !current.paused) {
			// Resuming an interrupted turn is allowed; the writer decides interrupted vs running.
			return
		}
		if (current.paused && record.type !== 'turn_resuming' && !CLOSES_OR_DECIDES.has(record.type)) {
			refuse(
				`turn ${current.turnId} is paused; only turn_resuming, a decision record or a terminal record may follow`,
			)
		}
		if (record.type === 'turn_paused' && current.paused) {
			refuse(`turn ${current.turnId} is already paused`)
		}
	}

	apply(record: SessionRecord, options: { readonly strict?: boolean } = {}): void {
		if (options.strict) this.check(record)
		switch (record.type) {
			case 'session_started':
				this.#started = true
				return
			case 'turn_started':
				this.#active = {
					turnId: record.turnId,
					startedSeq: record.seq,
					startedAt: record.ts,
					paused: false,
					ownerGen: record.gen,
				}
				this.#lastTurnId = record.turnId
				return
			case 'turn_paused':
				if (this.#active?.turnId === record.turnId) {
					this.#active = {
						...this.#active,
						paused: true,
						pausedCheckpointId: record.checkpointId,
					}
				}
				return
			case 'turn_resuming':
				if (this.#active?.turnId === record.turnId) {
					const { pausedCheckpointId: _dropped, ...rest } = this.#active
					this.#active = { ...rest, paused: false, ownerGen: record.gen }
				}
				return
			case 'turn_completed':
			case 'turn_failed':
				if (this.#active?.turnId === record.turnId) this.#active = undefined
				return
			default:
				return
		}
	}
}

/** Records that may follow a paused turn without resuming it. */
const CLOSES_OR_DECIDES: ReadonlySet<string> = new Set([
	'turn_completed',
	'turn_failed',
	'decision_requested',
	'decision_resolved',
	'decision_expired',
	'checkpoint_pruned',
	'audit',
	'log_repaired',
	'message_replaced',
	'session_updated',
])
