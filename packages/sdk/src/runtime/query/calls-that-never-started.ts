import type { SessionLog } from '../../store/session-log/index.js'
import type { SessionRecord } from '../../types/session/records.js'

/**
 * Ids of the tool calls the log proves never started.
 *
 * A call that started has a `tool_executing` record, so one with no result is
 * of unknown outcome. A call of a turn that journals its calls (it has a
 * `tool_executing` or a `tool_review_requested` record) and has none of its
 * own ran nothing: it was queued or waiting for approval when the process
 * ended. A turn with no such record proves nothing, so its calls are left out.
 */
export async function readCallsThatNeverStarted(log: SessionLog): Promise<ReadonlySet<string>> {
	const started = new Set<string>()
	const journaled = new Set<string>()
	const callsOfTurn = new Map<string, string[]>()
	for await (const entry of log.read()) {
		const record = entry.record as SessionRecord
		if (record.type === 'tool_review_requested') {
			journaled.add(record.turnId)
		} else if (record.type === 'tool_executing') {
			journaled.add(record.turnId)
			started.add(record.toolUseId)
		} else if (record.type === 'message') {
			const content = record.content as { role?: string; toolCalls?: readonly { id: string }[] }
			if (content?.role !== 'assistant' || !content.toolCalls) continue
			const ids = callsOfTurn.get(record.turnId) ?? []
			for (const call of content.toolCalls) ids.push(call.id)
			callsOfTurn.set(record.turnId, ids)
		}
	}
	const never = new Set<string>()
	for (const turnId of journaled) {
		for (const id of callsOfTurn.get(turnId) ?? []) if (!started.has(id)) never.add(id)
	}
	return never
}
