/**
 * What the daemon reads about a run's session: whether its lease is held,
 * and how its turn ended. Read-only, from the log and the lease files; the
 * daemon writes a session only to abandon an expired park and to archive old
 * runs.
 */

import {
	DiskSessionLog,
	SessionPaths,
	type TurnId,
	abandonTurn,
	asSessionId,
	isLeaseLive,
	readSessionLease,
} from '@namzu/sdk'
import { type ConversationFacts, readConversationFacts } from '../../integrations/sessions/store.js'

export interface RunSessionRef {
	readonly home: string
	readonly projectSlug: string
	readonly sessionId: string
}

function pathsOf(ref: RunSessionRef): SessionPaths {
	return new SessionPaths({ home: ref.home, slug: ref.projectSlug })
}

/** Whether somebody holds the session's writer lease right now. */
export async function sessionLeaseLive(ref: RunSessionRef, now = Date.now()): Promise<boolean> {
	const dir = pathsOf(ref).sessionDir({ sessionId: asSessionId(ref.sessionId) })
	try {
		return isLeaseLive(await readSessionLease(dir), now)
	} catch {
		return false
	}
}

export async function sessionFacts(ref: RunSessionRef): Promise<ConversationFacts | null> {
	try {
		return await readConversationFacts(
			{ paths: pathsOf(ref) },
			asSessionId(ref.sessionId),
			'tolerant',
		)
	} catch {
		return null
	}
}

/** How a settled turn ended: `completed`, `failed`, or `undefined` if the log does not say. */
export function turnOutcome(
	facts: ConversationFacts,
	turnId: string | undefined,
): { status: 'completed' | 'failed'; reason?: string } | undefined {
	for (let i = facts.records.length - 1; i >= 0; i--) {
		const record = facts.records[i] as {
			type: string
			turnId?: string
			error?: { message?: string; code?: string }
		}
		if (turnId && record.turnId !== turnId) continue
		if (record.type === 'turn_completed') return { status: 'completed' }
		if (record.type === 'turn_failed') {
			return {
				status: 'failed',
				...(record.error?.message ? { reason: record.error.message } : {}),
			}
		}
	}
	return undefined
}

/** Close a parked turn nobody answered in time (`turn_failed{ abandoned }`). */
export async function abandonParkedTurn(
	ref: RunSessionRef,
	turnId: string,
	reason: string,
): Promise<void> {
	const log = DiskSessionLog.at(pathsOf(ref), { sessionId: asSessionId(ref.sessionId) })
	await abandonTurn(asSessionId(ref.sessionId), turnId as TurnId, reason, { log })
}
