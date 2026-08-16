import type { TenantId, UserId } from '../ids/index.js'

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
	// `agentId` is a plain `string`, and that is a correction rather than a
	// loosening. It was annotated `AgentId` (`` `agt_${string}` ``) and every
	// value that ever reached it was an agent's REGISTRY KEY — `'worker'`,
	// `'supervisor'` — put there through an `as AgentId` cast. Nothing in this
	// kernel has ever minted an `agt_` id; there is no `generateAgentId`. Now
	// that the id types are nominal (NZ-SURF-11) the annotation could only be
	// satisfied by an assertion, so it would have documented a guarantee that
	// is impossible to hold rather than one nobody kept.
	| { kind: 'agent'; agentId: string; tenantId: TenantId; parentActor?: ActorRef }
	| { kind: 'system'; role: SystemRoleId; tenantId: TenantId }

/** Branded id for the {@link ActorRef} `system` variant. */
export type SystemRoleId = `sys_${string}`
