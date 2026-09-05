import type { TokenBudgetSnapshot } from '../../run/token-budget.js'
import { entityIdPattern } from '../../utils/id-format.js'
import { asProjectId, asRunId, asSessionId, asTenantId } from '../../utils/id.js'
import type { ProjectId, RunId, SessionId, TenantId } from '../ids/index.js'

/** The root run owns the ledger, including every descendant account. */
export interface TokenBudgetScope {
	readonly tenantId: TenantId
	readonly projectId: ProjectId
	readonly sessionId: SessionId
	readonly runId: RunId
}

/** JSON-safe checkpoint reference; the latest ledger remains authoritative. */
export interface TokenBudgetBinding {
	readonly scope: TokenBudgetScope
	readonly accountId: string
}

/**
 * Durable storage for one canonical token ledger per root run.
 *
 * A root and all its descendants share one writer. Save must atomically
 * replace a complete record; a missing record is null and corrupt records
 * throw. This interface provides no compare-and-swap or distributed lease.
 * Hosts must ensure exclusive root ownership when resuming in another process.
 */
export interface TokenBudgetStore {
	load(scope: TokenBudgetScope): Promise<TokenBudgetSnapshot | null>
	save(scope: TokenBudgetScope, snapshot: TokenBudgetSnapshot): Promise<void>
}

/** Validate an untrusted checkpoint reference without inventing missing identity. */
export function validateTokenBudgetBinding(value: unknown): TokenBudgetBinding {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Invalid token budget binding')
	}
	const binding = value as Partial<TokenBudgetBinding>
	if (typeof binding.accountId !== 'string' || !entityIdPattern().test(binding.accountId)) {
		throw new Error('Invalid token budget account identity')
	}
	if (typeof binding.scope !== 'object' || binding.scope === null) {
		throw new Error('Token budget binding is missing its root scope')
	}
	return {
		accountId: binding.accountId,
		scope: {
			tenantId: asTenantId(binding.scope.tenantId),
			projectId: asProjectId(binding.scope.projectId),
			sessionId: asSessionId(binding.scope.sessionId),
			runId: asRunId(binding.scope.runId),
		},
	}
}
