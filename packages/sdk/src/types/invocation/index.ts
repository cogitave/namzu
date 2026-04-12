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
	/** Tenant context for multi-tenant isolation (if applicable) */
	readonly tenantId?: TenantId

	/** Request-scoped metadata (user info, session, correlation IDs, etc.) */
	readonly metadata?: Readonly<Record<string, unknown>>

	/** Shared services (DB clients, external APIs, cache, etc.) */
	readonly services?: Readonly<Record<string, unknown>>

	/** Parent agent chain for debugging/tracing (agent IDs in order) */
	readonly parentChain?: readonly string[]
}

/**
 * Create a child invocation state with the current agent appended to parentChain.
 *
 * This function is called by SupervisorAgent and RouterAgent when delegating
 * to sub-agents. It ensures the full agent hierarchy is tracked for debugging,
 * logging, and tenant isolation validation.
 *
 * @param parent The parent invocation state (may be undefined for top-level agents)
 * @param currentAgentId The ID of the agent making the delegation
 * @returns A new InvocationState with currentAgentId appended to parentChain
 */
export function deriveChildState(
	parent: InvocationState | undefined,
	currentAgentId: string,
): InvocationState {
	const parentChain = parent?.parentChain
		? [...parent.parentChain, currentAgentId]
		: [currentAgentId]

	return {
		tenantId: parent?.tenantId,
		metadata: parent?.metadata,
		services: parent?.services,
		parentChain,
	}
}
