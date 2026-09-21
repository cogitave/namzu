import { type CompactNowInput, type CompactionResult, compactNow } from '../../compaction/manual.js'
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
	/** Where to find the session's log, and the lease to append under. */
	readonly locator?: SessionLocatorOptions
}

/**
 * Compact a session outside any turn. Reads the session's context from its
 * log, compacts it, and appends a `compaction{ trigger: 'manual' }` record
 * with no `turnId`: the messages the pass kept are named by id, the summary
 * is recorded in full, and the shed messages stay in the log for audit.
 *
 * Refused while a turn is active (`TurnInProgressError`). `null` when there
 * was nothing to compact; nothing is appended then.
 */
export async function compactSession(
	params: CompactSessionParams,
): Promise<CompactionResult | null> {
	const { sessionId, locator = {}, ...input } = params
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
