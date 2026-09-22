import { type SessionLog, SessionMessageFold } from '../store/session-log/index.js'
import type { SpillRef } from '../store/session-log/spill.js'
import type { TenantId } from '../types/ids/index.js'
import type { Message } from '../types/message/index.js'
import type { SessionMessage } from '../types/session/messages.js'
import type { SessionRecord } from '../types/session/records.js'

/**
 * A session's conversation as {@link SessionMessage}s: the fold of its log
 * (with every `message_replaced` applied), each message carrying the id and
 * time of its record. A compaction summary message has no record of its own
 * and carries the compaction's time and no id of its own; it is skipped.
 */
export async function readSessionMessages(
	log: SessionLog,
	tenantId: TenantId,
): Promise<SessionMessage[]> {
	const fold = new SessionMessageFold()
	const times = new Map<number, string>()
	for await (const { record } of log.read()) {
		times.set(record.seq, record.ts)
		fold.apply(record as SessionRecord)
	}
	const out: SessionMessage[] = []
	for (const entry of fold.entries()) {
		if (!entry.messageId) continue
		const message = entry.spill
			? (JSON.parse(await log.readSpill(entry.spill as SpillRef)) as Message)
			: entry.message
		out.push({
			id: entry.messageId,
			sessionId: log.sessionId,
			tenantId,
			message,
			at: new Date(times.get(entry.seq) ?? 0),
		})
	}
	return out
}
