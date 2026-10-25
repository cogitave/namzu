import {
	type CompactNowInput,
	type CompactionResult,
	compactNow,
	compactRegion,
} from '../../compaction/manual.js'
import { readFoldedHistory } from '../../manager/session/turn-recorder.js'
import { NamzuError } from '../../types/errors/index.js'
import type { MessageId, SessionId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import { TurnInProgressError } from '../../types/session/turn.js'
import { generateMessageId } from '../../utils/id.js'
import { type SessionLocatorOptions, locateSessionLog, withSessionLease } from './abandon-turn.js'

/** A compaction a host asks for between turns. */
export interface CompactSessionParams extends Omit<CompactNowInput, 'messages' | 'onShed'> {
	readonly sessionId: SessionId
	/**
	 * Who asked. `'manual'` (the default) is a person's request; `'idle'` is a
	 * host compacting a conversation nobody is using before its prompt cache
	 * lapses. Recorded on the `compaction` record.
	 */
	readonly trigger?: 'manual' | 'idle'
	/** Where to find the session's log, and the lease to append under. */
	readonly locator?: SessionLocatorOptions
}

/**
 * Compact a session outside any turn. Reads the session's context from its
 * log, compacts it, and appends a `compaction{ trigger }` record (`'manual'` unless the host says `'idle'`)
 * with no `turnId`: the messages the pass kept are named by id, the summary
 * is recorded in full, and the shed messages stay in the log for audit.
 *
 * Refused while a turn is active (`TurnInProgressError`). `null` when there
 * was nothing to compact; nothing is appended then.
 */
export async function compactSession(
	params: CompactSessionParams,
): Promise<CompactionResult | null> {
	const { sessionId, locator = {}, trigger = 'manual', ...input } = params
	const log = await locateSessionLog(sessionId, locator)
	return withSessionLease(log, locator.lease, async (lease) => {
		const active = await log.activeTurn({ lease })
		if (active) {
			throw new TurnInProgressError({ sessionId, activeTurnId: active.turnId, state: active.state })
		}
		const history = await readFoldedHistory(log)
		const ids = new Map<Message, MessageId>()
		for (const entry of history) if (entry.messageId) ids.set(entry.message, entry.messageId)
		const result = await compactNow({ ...input, messages: history.map((entry) => entry.message) })
		if (!result) return null
		const head = await log.head()
		if (!head) {
			throw new NamzuError({
				code: 'not_found',
				message: `Session ${sessionId} has an empty log; there is nothing to compact.`,
				details: { sessionId },
			})
		}
		const { summary, keptMessageIds } = compactionShape(result.messages, ids)
		await log.append(lease, {
			type: 'compaction',
			compactionId: generateMessageId(),
			strategy: input.config.strategy,
			trigger,
			replacesSeqRange: [1, head.pointer.seq],
			summary,
			keptMessageIds,
			tokensBefore: 0,
			tokensAfter: 0,
		})
		return result
	})
}

/** A compaction of one span of a session's context, asked for between turns. */
export interface CompactSessionRangeParams extends CompactSessionParams {
	/**
	 * The first message to summarise, by the id the log recorded it under.
	 * Omitted: the span starts at the beginning of the context.
	 */
	readonly from?: MessageId
	/**
	 * The message the span stops before; it and everything after it stay as
	 * they are. Omitted: the span runs to the end of the context.
	 */
	readonly until?: MessageId
}

/**
 * Compact one span of a session's context outside any turn.
 *
 * Like {@link compactSession}, but only the messages from `from` up to (not
 * including) `until` are summarised; the rest of the context stays verbatim.
 * A host uses it to fold away "everything before this message" or "this
 * message and everything after it" without touching the other side. Pinned
 * (`retain`) messages inside the span stay as they are.
 *
 * Throws `not_found` when `from` or `until` is not in the session's current
 * context (a compaction may already have folded it away), and
 * `invalid_config` when a boundary would split a tool call from its result.
 * `null` when the span holds nothing worth summarising; nothing is appended
 * then. Refused while a turn is active (`TurnInProgressError`).
 */
export async function compactSessionRange(
	params: CompactSessionRangeParams,
): Promise<CompactionResult | null> {
	const { sessionId, locator = {}, from, until, ...input } = params
	const log = await locateSessionLog(sessionId, locator)
	return withSessionLease(log, locator.lease, async (lease) => {
		const active = await log.activeTurn({ lease })
		if (active) {
			throw new TurnInProgressError({ sessionId, activeTurnId: active.turnId, state: active.state })
		}
		const history = await readFoldedHistory(log)
		const position = (id: MessageId | undefined, fallback: number): number => {
			if (id === undefined) return fallback
			const at = history.findIndex((entry) => entry.messageId === id)
			if (at < 0) {
				throw new NamzuError({
					code: 'not_found',
					message: `Message ${id} is not in session ${sessionId}'s current context; it may already have been summarised.`,
					details: { sessionId, messageId: id },
				})
			}
			return at
		}
		const start = position(from, 0)
		const end = position(until, history.length)
		const ids = new Map<Message, MessageId>()
		for (const entry of history) if (entry.messageId) ids.set(entry.message, entry.messageId)
		const result = await compactRegion({
			...input,
			messages: history.map((entry) => entry.message),
			start,
			end,
		})
		if (!result) return null
		const head = await log.head()
		if (!head) {
			throw new NamzuError({
				code: 'not_found',
				message: `Session ${sessionId} has an empty log; there is nothing to compact.`,
				details: { sessionId },
			})
		}
		const { summary, keptMessageIds } = compactionShape(result.messages, ids)
		await log.append(lease, {
			type: 'compaction',
			compactionId: generateMessageId(),
			strategy: input.config.strategy,
			trigger: 'manual',
			replacesSeqRange: [1, head.pointer.seq],
			summary,
			keptMessageIds,
			tokensBefore: 0,
			tokensAfter: 0,
		})
		return result
	})
}

/**
 * Express a compacted context as a `compaction` record: the new messages
 * before the first recorded one are its summary and the recorded ones are
 * kept, when they are still in log order; otherwise the whole context is the
 * summary.
 */
function compactionShape(
	messages: readonly Message[],
	ids: ReadonlyMap<Message, MessageId>,
): { summary: Message[]; keptMessageIds: MessageId[] } {
	const order = new Map([...ids.values()].map((id, index) => [id, index]))
	const first = messages.findIndex((message) => ids.has(message))
	if (first < 0) return { summary: [...messages], keptMessageIds: [] }
	const kept = messages.slice(first)
	let previous = -1
	for (const message of kept) {
		const id = ids.get(message)
		const position = id === undefined ? -1 : (order.get(id) ?? -1)
		if (id === undefined || position <= previous) {
			return { summary: [...messages], keptMessageIds: [] }
		}
		previous = position
	}
	return {
		summary: messages.slice(0, first),
		keptMessageIds: kept.map((message) => ids.get(message) as MessageId),
	}
}
