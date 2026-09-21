import type { SessionLocatorOptions } from '../runtime/query/abandon-turn.js'
import { NamzuError } from '../types/errors/index.js'
import type { SessionId } from '../types/ids/index.js'
import type { FencingToken, LeaseSummary } from '../types/session/durable.js'
import type { ClaimSessionOptions, SessionLease } from './session-log/index.js'

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
	_sessionId: SessionId,
	_options: ClaimSessionOptions & Omit<SessionLocatorOptions, 'lease'>,
): Promise<SessionLease | null> {
	throw new Error('train: not yet wired')
}

/**
 * Give a lease up early. Idempotent; presenting a superseded lease releases
 * nothing.
 */
export async function releaseSession(
	_sessionId: SessionId,
	_lease: SessionLease,
	_options?: Omit<SessionLocatorOptions, 'lease'>,
): Promise<void> {
	throw new Error('train: not yet wired')
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
