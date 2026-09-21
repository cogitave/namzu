import { resolveNamzuHome } from '../../session/home.js'
import { type SessionIndex, openSessionIndex } from '../../store/session-index/index.js'
import {
	DiskSessionLog,
	type SessionLease,
	type SessionLog,
} from '../../store/session-log/index.js'
import { NamzuError } from '../../types/errors/index.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'

/** How a session-level operation finds the session's log. */
export interface SessionLocatorOptions {
	/** Use this log directly. */
	readonly log?: SessionLog
	/** Otherwise resolve the log through this index. */
	readonly index?: SessionIndex
	/** Otherwise open the index under this home. Defaults to `resolveNamzuHome()`. */
	readonly home?: string
	/** A lease the caller already holds. Absent: the lease is claimed and released around the append. */
	readonly lease?: SessionLease
}

/** Lease time-to-live for a lease a session-level operation claims for one append. */
const OPERATION_LEASE_TTL_MS = 30_000

/**
 * The log a session-level operation acts on: the one given, or the one the
 * index files the session under.
 */
export async function locateSessionLog(
	sessionId: SessionId,
	options: Omit<SessionLocatorOptions, 'lease'> = {},
): Promise<SessionLog> {
	if (options.log) {
		if (options.log.sessionId !== sessionId) {
			throw new NamzuError({
				code: 'invalid_config',
				message: `The log given belongs to session ${options.log.sessionId}, not ${sessionId}.`,
				details: { sessionId, logSessionId: options.log.sessionId },
			})
		}
		return options.log
	}
	const index =
		options.index ?? (await openSessionIndex({ home: options.home ?? resolveNamzuHome() }))
	try {
		const session = await index.getSession(sessionId)
		if (!session) {
			throw new NamzuError({
				code: 'not_found',
				message: `Session ${sessionId} is not in the session index.`,
				details: { sessionId },
			})
		}
		return new DiskSessionLog({
			sessionId,
			file: session.logPath,
			sessionDir: session.logPath.replace(/\.jsonl$/, ''),
		})
	} finally {
		if (!options.index) index.close()
	}
}

/**
 * Run `operation` under the session's writer lease: the caller's, or one
 * claimed for the operation and released after it. A session leased by a
 * live writer is refused rather than waited for.
 */
export async function withSessionLease<T>(
	log: SessionLog,
	lease: SessionLease | undefined,
	operation: (lease: SessionLease) => Promise<T>,
): Promise<T> {
	if (lease) return operation(lease)
	const claimed = await log.claim({
		holder: `namzu:${process.pid}:${log.sessionId}`,
		ttlMs: OPERATION_LEASE_TTL_MS,
	})
	if (!claimed) {
		throw new NamzuError({
			code: 'invalid_config',
			message: `Session ${log.sessionId} is leased by a live writer; pass its lease, or wait for it to finish.`,
			details: { sessionId: log.sessionId },
		})
	}
	try {
		return await operation(claimed)
	} finally {
		await log.release(claimed).catch(() => undefined)
	}
}

/**
 * Close a session's active turn without resuming it: appends
 * `turn_failed{ error.code: 'abandoned', reason }` and frees the session for
 * its next turn. The only other way out of a paused turn is `resumeSession`.
 *
 * A running turn is refused with `TurnInProgressError`: it is cancelled by
 * its own process, not abandoned from outside.
 */
export async function abandonTurn(
	sessionId: SessionId,
	turnId: TurnId,
	reason: string,
	options: SessionLocatorOptions = {},
): Promise<void> {
	const log = await locateSessionLog(sessionId, options)
	await withSessionLease(log, options.lease, (lease) => log.abandonTurn(lease, turnId, reason))
}
