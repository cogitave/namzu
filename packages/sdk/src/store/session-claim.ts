import { type SessionLocatorOptions, locateSessionLog } from '../runtime/query/abandon-turn.js'
import { invariants } from '../invariants/index.js'
import { NamzuError } from '../types/errors/index.js'
import type { SessionId } from '../types/ids/index.js'
import type { FencingToken, LeaseSummary } from '../types/session/durable.js'
import type { ClaimSessionOptions, SessionLease, SessionLog } from './session-log/index.js'

/**
 * Take exclusive working possession of a session (its `lease.json`), or
 * report that somebody else holds it. `null` is the ordinary outcome of a
 * queue with more than one reader, not an error.
 *
 * A lease expires; claiming an expired one succeeds and mints a fence
 * strictly greater than every fence issued before, so the stalled holder's
 * next append is refused.
 */
export async function claimSession(
	sessionId: SessionId,
	options: ClaimSessionOptions & Omit<SessionLocatorOptions, 'lease'>,
): Promise<SessionLease | null> {
	const { log: given, index, home, ...claim } = options
	const log = await locateSessionLog(sessionId, {
		...(given ? { log: given } : {}),
		...(index ? { index } : {}),
		...(home ? { home } : {}),
	})
	return log.claim(claim)
}

/**
 * Give a lease up early. Idempotent; presenting a superseded lease releases
 * nothing.
 */
export async function releaseSession(
	sessionId: SessionId,
	lease: SessionLease,
	options: Omit<SessionLocatorOptions, 'lease'> = {},
): Promise<void> {
	const log = await locateSessionLog(sessionId, options)
	await log.release(lease)
}

/** A lease as a listing reports it, judged against one clock. */
export function toClaimSummary(lease: SessionLease, now: number): LeaseSummary {
	return {
		holder: lease.holder,
		fence: lease.fence,
		expiresAt: lease.expiresAt,
		expired: now >= lease.expiresAt,
	}
}

/** The refusal for an append presented under a superseded lease. */
export function fencedOut(
	sessionId: SessionId,
	presented: FencingToken,
	current: FencingToken,
): NamzuError {
	return new NamzuError({
		code: 'storage_error',
		message: `Refusing an append to session ${sessionId} fenced at ${presented}: the session is now leased at ${current}. Another worker took it over, so this process no longer holds it. Stop rather than retrying: the lease is gone, not busy.`,
		details: { sessionId, presentedFence: presented, currentFence: current },
		retryable: false,
	})
}

/** What `session-log:single-open-writer` is evaluated against: one session and the fence a writer presents. */
export interface SingleOpenWriterContext {
	readonly log: SessionLog
	readonly presentedFence: FencingToken
}

/**
 * One writer per session: a writer presenting a fence below the session's
 * current lease is a stalled holder somebody took the session from.
 * Evaluated per session; without one it reports `unknown`.
 */
invariants.register<SingleOpenWriterContext | undefined>(
	'session-log',
	'single-open-writer',
	async (ctx) => {
		if (!ctx) {
			return {
				state: 'unknown',
				reason:
					'no session log given — this invariant is evaluated per session, not for the process as a whole',
			}
		}
		const current = await ctx.log.lease()
		if (current && ctx.presentedFence < current.fence) {
			const holderNote = current.holder ? ` (now held by "${current.holder}")` : ''
			return {
				state: 'violated',
				detail:
					`presented fence ${ctx.presentedFence} is behind this session's current fence ` +
					`${current.fence}${holderNote} — another worker has taken this session over`,
			}
		}
		return { state: 'holds' }
	},
)
