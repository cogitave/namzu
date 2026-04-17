/**
 * Linkage helpers for {@link SessionStore} — pure functions over raw store
 * maps so they can be reused by both {@link InMemorySessionStore} and
 * {@link DiskSessionStore}.
 *
 * See session-hierarchy.md §10.4 (Parent-Child Linkage) and §14.3 (drill
 * primitive). Ancestry walks are cycle-guarded via visited-set; detection
 * surfaces as {@link AncestryCycleError}.
 */

import { AncestryCycleError } from '../../session/errors.js'
import type { SubSession } from '../../session/hierarchy/sub-session.js'
import type { SessionId } from '../../types/ids/index.js'
import type { SubSessionId } from '../../types/session/ids.js'

/**
 * Read shape required by the pure linkage helpers. Both in-memory and disk
 * stores project their internal state into this view before delegating.
 */
export interface LinkageView {
	findChildSubSessions(parentSessionId: SessionId): readonly SubSession[]
	findParentSubSession(childSessionId: SessionId): SubSession | null
}

/**
 * Returns direct children of `sessionId` (one level). Pure over `view`.
 */
export function getChildren(view: LinkageView, sessionId: SessionId): readonly SubSession[] {
	return view.findChildSubSessions(sessionId)
}

/**
 * Walks parent sub-session links and returns the session id chain from root
 * to `sessionId` inclusive. Guards against cycles via a visited-set — in
 * a healthy store the invariant holds and the guard never fires; a cycle
 * indicates corruption (session-hierarchy.md §4.5 enforces acyclicity on
 * write).
 */
export function getAncestry(view: LinkageView, sessionId: SessionId): readonly SessionId[] {
	const visited = new Set<SessionId>()
	const chain: SessionId[] = []
	let cursor: SessionId | null = sessionId

	while (cursor !== null) {
		if (visited.has(cursor)) {
			throw new AncestryCycleError({
				sessionId,
				cyclePath: [...chain, cursor],
			})
		}
		visited.add(cursor)
		chain.push(cursor)

		const parentEdge: SubSession | null = view.findParentSubSession(cursor)
		cursor = parentEdge ? parentEdge.parentSessionId : null
	}

	// Reverse so the result is root-to-self, matching session-hierarchy.md §14.3.
	return chain.reverse()
}

/**
 * Pairs {@link SubSession} children with a stable order (spawnedAt ascending,
 * then id as a deterministic tiebreaker). Callers that need a different
 * ordering can re-sort.
 */
export function orderChildren(children: readonly SubSession[]): readonly SubSession[] {
	return [...children].sort((a, b) => {
		const ta = a.spawnedAt.getTime()
		const tb = b.spawnedAt.getTime()
		if (ta !== tb) return ta - tb
		return compareSubSessionId(a.id, b.id)
	})
}

function compareSubSessionId(a: SubSessionId, b: SubSessionId): number {
	if (a < b) return -1
	if (a > b) return 1
	return 0
}
