/**
 * Delegation capacity validation — depth + width caps applied at the kernel
 * boundary before any write (session-hierarchy.md §6.5).
 *
 * Both `spawnSubSession()` and `broadcastHandoff()` call this module before
 * committing; violations abort with typed {@link DelegationCapacityExceeded}
 * and no partial writes occur (Convention #0: no workarounds; Convention #5:
 * deny-by-default).
 */

import type { SessionId, TenantId } from '../../types/ids/index.js'
import type { SessionStore } from '../../types/session/store.js'

/** Capacity dimension under validation. */
export type CapacityDimension = 'depth' | 'width'

/**
 * Raised when a spawn / broadcast would exceed the project's configured
 * capacity caps. The check is a precondition — no partial writes occur on
 * violation (session-hierarchy.md §6.5).
 */
export class DelegationCapacityExceeded extends Error {
	readonly details: {
		dimension: CapacityDimension
		current: number
		limit: number
		sessionId: SessionId
	}

	constructor(details: {
		dimension: CapacityDimension
		current: number
		limit: number
		sessionId: SessionId
	}) {
		super(
			`Delegation capacity exceeded: ${details.dimension} ${details.current}/${details.limit} on ${details.sessionId}`,
		)
		this.name = 'DelegationCapacityExceeded'
		this.details = details
	}
}

/**
 * Capacity validator abstraction. Lets the handoff flows inject a validator
 * without carrying the full {@link SessionStore} surface area into their
 * dependency envelope (Convention #9: function-based flow keeps deps narrow).
 *
 * Both methods throw {@link DelegationCapacityExceeded} on violation and
 * return void on success.
 */
export interface CapacityValidator {
	/**
	 * Asserts `parentSession.depth + 1 ≤ projectMaxDepth`. Depth is computed by
	 * walking the ancestry via {@link SessionStore.getAncestry} — root-to-self
	 * length minus one equals the session's depth in the delegation tree.
	 */
	validateDepth(
		parentSessionId: SessionId,
		projectMaxDepth: number,
		tenantId: TenantId,
	): Promise<void>

	/**
	 * Asserts `existingDirectChildren + pendingNewChildren ≤ projectMaxWidth`
	 * under `parentSessionId`. The width cap applies to a single spawn call —
	 * a broadcast of N recipients passes `pendingNewChildren = N`.
	 */
	validateWidth(
		parentSessionId: SessionId,
		pendingNewChildren: number,
		projectMaxWidth: number,
		tenantId: TenantId,
	): Promise<void>
}

/**
 * Default validator backed by {@link SessionStore}. Uses `getAncestry` for
 * depth (root-to-self chain length) and `getChildren` for width (count of
 * existing direct sub-sessions).
 */
export class DefaultCapacityValidator implements CapacityValidator {
	constructor(private readonly store: SessionStore) {}

	async validateDepth(
		parentSessionId: SessionId,
		projectMaxDepth: number,
		tenantId: TenantId,
	): Promise<void> {
		const ancestry = await this.store.getAncestry(parentSessionId, tenantId)
		// depth is 0-indexed — root session has depth 0. New child depth =
		// ancestry length (root-to-parent inclusive).
		const newDepth = ancestry.length
		if (newDepth > projectMaxDepth) {
			throw new DelegationCapacityExceeded({
				dimension: 'depth',
				current: newDepth,
				limit: projectMaxDepth,
				sessionId: parentSessionId,
			})
		}
	}

	async validateWidth(
		parentSessionId: SessionId,
		pendingNewChildren: number,
		projectMaxWidth: number,
		tenantId: TenantId,
	): Promise<void> {
		const existing = await this.store.getChildren(parentSessionId, tenantId)
		const total = existing.length + pendingNewChildren
		if (total > projectMaxWidth) {
			throw new DelegationCapacityExceeded({
				dimension: 'width',
				current: total,
				limit: projectMaxWidth,
				sessionId: parentSessionId,
			})
		}
	}
}
