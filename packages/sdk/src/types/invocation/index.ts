import type { TenantId } from '../ids/index.js'

/**
 * Shared state passed through agent hierarchies.
 *
 * This state is NOT visible to the LLM — it carries runtime context
 * like DB clients, tenant info, session metadata, etc. that sub-agents
 * need to access but should not expose to the LLM.
 *
 * The invocation state flows through the entire agent call chain:
 * - Top-level caller creates or provides initial state
 * - SupervisorAgent/RouterAgent derives child state with extended parentChain
 * - Child agents receive the state in their config
 * - Tools can access state via ToolContext.invocationState
 */
export interface InvocationState {
	/**
	 * Isolation boundary — required in 0.2.0 per session-hierarchy.md §12.1.
	 * Every store accessor downstream branches on this id; omission is a
	 * compile-time error.
	 */
	readonly tenantId: TenantId

	/** Request-scoped metadata (user info, session, correlation IDs, etc.) */
	readonly metadata?: Readonly<Record<string, unknown>>

	/** Shared services (DB clients, external APIs, cache, etc.) */
	readonly services?: Readonly<Record<string, unknown>>

	/** Parent agent chain for debugging/tracing (agent IDs in order) */
	readonly parentChain?: readonly string[]
}

/**
 * Params for {@link deriveChildState} when the parent is absent. `tenantId`
 * is required even at the top level — the kernel refuses to guess tenant
 * identity (session-hierarchy.md §12.1).
 */
export interface DeriveChildStateRoot {
	readonly tenantId: TenantId
}

/**
 * Create a child invocation state with the current agent appended to parentChain.
 *
 * This function is called by SupervisorAgent and RouterAgent when delegating
 * to sub-agents. It ensures the full agent hierarchy is tracked for debugging,
 * logging, and tenant isolation validation.
 *
 * When `parent` is undefined (top-level agent), a minimal root context is
 * required so `tenantId` can be seeded — see {@link DeriveChildStateRoot}.
 * `InvocationState.tenantId` is required in 0.2.0 (§12.1).
 *
 * @param parent The parent invocation state, or a root seed carrying `tenantId`.
 * @param currentAgentId The ID of the agent making the delegation
 * @returns A new InvocationState with currentAgentId appended to parentChain
 */
export function deriveChildState(
	parent: InvocationState | DeriveChildStateRoot,
	currentAgentId: string,
): InvocationState {
	const existingChain = 'parentChain' in parent ? parent.parentChain : undefined
	const parentChain = existingChain ? [...existingChain, currentAgentId] : [currentAgentId]

	return {
		tenantId: parent.tenantId,
		metadata: 'metadata' in parent ? parent.metadata : undefined,
		services: 'services' in parent ? parent.services : undefined,
		parentChain,
	}
}
