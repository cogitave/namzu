/**
 * Typed errors for the session hierarchy module.
 *
 * See session-hierarchy.md §12.2 (cross-tenant rejection), §6.2 (workspace
 * backend operation failures), §4.5 (intervention DAG). Each error carries a
 * structured `details` payload so consumers can route without string parsing
 * (Convention #5: deny-by-default, fail fast).
 */

import type { SessionId, TenantId } from '../types/ids/index.js'
import type { WorkspaceBackendKind } from './workspace/driver.js'

/**
 * Raised by {@link SessionStore} accessors when the supplied {@link TenantId}
 * does not match the tenant owning the target resource. Convention #17:
 * cross-tenant access is a hard error at the kernel boundary — there is no
 * escape hatch. See session-hierarchy.md §12.2.
 */
export class TenantIsolationError extends Error {
	readonly details: {
		requested: TenantId
		resource: string
	}

	constructor(details: { requested: TenantId; resource: string }) {
		super(`Tenant isolation violation: ${details.requested} accessed ${details.resource}`)
		this.name = 'TenantIsolationError'
		this.details = details
	}
}

/**
 * Raised by {@link SessionStore.getAncestry} / {@link SessionStore.drill}
 * when walking parent sub-session links encounters a revisit. Indicates store
 * corruption — the write path enforces acyclicity (session-hierarchy.md §4.5).
 */
export class AncestryCycleError extends Error {
	readonly details: {
		sessionId: SessionId
		cyclePath: readonly SessionId[]
	}

	constructor(details: { sessionId: SessionId; cyclePath: readonly SessionId[] }) {
		super(
			`Ancestry cycle detected starting at ${details.sessionId}: ${details.cyclePath.join(' -> ')}`,
		)
		this.name = 'AncestryCycleError'
		this.details = details
	}
}

/**
 * Raised by {@link WorkspaceBackendDriver} implementations on any I/O or
 * invariant failure. Wraps the underlying cause; callers can match on
 * `details.op` + `details.kind` for routing (Convention #0: no silent
 * fallbacks — surface the failure). See session-hierarchy.md §6.2 / §7.
 */
export class WorkspaceBackendError extends Error {
	readonly details: {
		op: string
		kind: WorkspaceBackendKind
		cause?: unknown
	}

	constructor(details: { op: string; kind: WorkspaceBackendKind; cause?: unknown }) {
		super(`Workspace backend ${details.kind} failed on ${details.op}`)
		this.name = 'WorkspaceBackendError'
		this.details = details
	}
}
