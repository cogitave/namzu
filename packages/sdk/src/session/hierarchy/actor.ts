import type { AgentId, TenantId, UserId } from '../../types/ids/index.js'

/**
 * Discriminated union of actors that can own a {@link Session}.
 *
 * See session-hierarchy.md §4.3. The `parentActor` field on the agent variant
 * pairs with {@link Lineage} (§10.4) — permission audit events walk this
 * chain to attribute subagent actions back to the originating user. Renamed
 * from `spawnedBy` during the 0.2.0 design phase (no shim kept).
 */
export type ActorRef =
	| { kind: 'user'; userId: UserId; tenantId: TenantId }
	| { kind: 'agent'; agentId: AgentId; tenantId: TenantId; parentActor?: ActorRef }
	| { kind: 'system'; role: SystemRoleId; tenantId: TenantId }

/** Branded id for the {@link ActorRef} `system` variant. */
export type SystemRoleId = `sys_${string}`
