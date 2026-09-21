import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SessionLog, SessionRecordDraft } from '../../store/session-log/index.js'
import type { SessionId } from '../../types/ids/index.js'
import { type ChildSessionMeta, ChildSessionMetaSchema } from '../../types/session/records.js'
import { atomicWriteFile } from '../../utils/atomic-write.js'

/**
 * A child session, as its parent sees it (spec §4.2, "Children").
 *
 * A delegated agent runs as a child session: its own log at
 * `<parent-session-dir>/subagents/<child-id>.jsonl`, a convenience document
 * `<child-id>.meta.json` beside it, and, in the parent's log, a
 * `child_session_spawned` record when it starts and a `child_session_ended`
 * record when it settles. This module holds the pieces of that which do not
 * depend on who holds the parent's lease: the meta document, the ended
 * record derived from the child's own log, and the process-local lookup of
 * a live child's log.
 */

/** `child_session_ended`, as the parent's writer appends it. */
export type ChildSessionEndedDraft = Extract<SessionRecordDraft, { type: 'child_session_ended' }>

/**
 * The parent's `child_session_ended` record for a child, read from the
 * child's own terminal record so the two cannot disagree: the status, stop
 * reason, answer message, usage and cost are copied from the settlement of
 * the child's last `turn_completed` or `turn_failed`. `null` while the child
 * has no settled turn.
 *
 * The draft carries no `turnId`. The parent's writer adds the spawning turn's
 * id when that turn is still open, and leaves it out otherwise (the child
 * belongs to the turn its `child_session_spawned` names).
 */
export async function childSessionEnded(
	childLog: SessionLog,
): Promise<ChildSessionEndedDraft | null> {
	let ended: ChildSessionEndedDraft | null = null
	for await (const { record } of childLog.read({ mode: 'tolerant' })) {
		if (record.type !== 'turn_completed' && record.type !== 'turn_failed') continue
		const { settlement } = record
		ended = {
			type: 'child_session_ended',
			childSessionId: childLog.sessionId,
			status: settlement.status,
			...(record.type === 'turn_completed' && record.stopReason !== undefined
				? { stopReason: record.stopReason }
				: {}),
			...(settlement.resultMessageId !== undefined
				? { resultMessageId: settlement.resultMessageId }
				: {}),
			usage: settlement.usage,
			cost: settlement.cost,
		}
	}
	return ended
}

/** A `<child-id>.meta.json` that belongs to another child or another parent. */
export class ChildSessionMetaOwnerError extends Error {
	override readonly name = 'ChildSessionMetaOwnerError'
}

/**
 * Write `<child-id>.meta.json`, atomically and with an owner check: an
 * existing document must name the same child, parent and parent turn, or the
 * write is refused rather than repointing it. The document is a convenience
 * only; the child's log wins on any disagreement.
 */
export async function writeChildSessionMeta(path: string, meta: ChildSessionMeta): Promise<void> {
	const next = ChildSessionMetaSchema.parse(meta)
	const current = await readChildSessionMeta(path)
	if (
		current !== null &&
		(current.sessionId !== next.sessionId ||
			current.parentSessionId !== next.parentSessionId ||
			current.parentTurnId !== next.parentTurnId)
	) {
		throw new ChildSessionMetaOwnerError(
			`${path} describes child session ${current.sessionId} of ${current.parentSessionId}; refusing to overwrite it with ${next.sessionId} of ${next.parentSessionId}.`,
		)
	}
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	await atomicWriteFile(path, `${JSON.stringify(next)}\n`, { mode: 0o600 })
}

/** The meta document at `path`, or `null` when there is none. Throws on one that does not parse. */
export async function readChildSessionMeta(path: string): Promise<ChildSessionMeta | null> {
	let raw: string
	try {
		raw = await readFile(path, 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
		throw error
	}
	return ChildSessionMetaSchema.parse(JSON.parse(raw))
}

/**
 * The logs of the child sessions running in this process, by child id.
 *
 * A disk child's log can be reopened from its path; an in-memory one exists
 * only as the object its manager built. The parent's writer reads the
 * child's terminal record from here to append `child_session_ended`. Each
 * entry lives as long as its child's spawn record in the `AgentManager`.
 */
const liveChildLogs = new Map<SessionId, SessionLog>()

/** Register a live child's log; the returned function removes it. */
export function registerChildSessionLog(log: SessionLog): () => void {
	liveChildLogs.set(log.sessionId, log)
	return () => {
		if (liveChildLogs.get(log.sessionId) === log) liveChildLogs.delete(log.sessionId)
	}
}

/** The log of a child session running in this process, if there is one. */
export function childSessionLog(childSessionId: SessionId): SessionLog | undefined {
	return liveChildLogs.get(childSessionId)
}
