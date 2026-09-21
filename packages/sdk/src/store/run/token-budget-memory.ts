import type { TokenBudgetSnapshot } from '../../run/token-budget.js'
import type { TokenBudgetScope, TokenBudgetStore } from '../../types/run/token-budget-store.js'
import { assertSameRoot, validateScope, validateSnapshotScope } from './token-budget-disk.js'

/**
 * Process-local {@link TokenBudgetStore}: one ledger per root run, no
 * filesystem.
 *
 * It refuses exactly what {@link import('./token-budget-disk.js').DiskTokenBudgetStore}
 * refuses — a snapshot for another root, a replaced root account, reduced
 * usage, a forgotten receipt — so a host that tests against one and ships the
 * other sees the same answers. Records are copied on the way in and out, so a
 * caller holding a snapshot cannot change what the store holds.
 *
 * `query()` uses one of these, held by the run store, when a host passes an
 * {@link import('./memory.js').InMemoryRunStore} and none of
 * `tokenBudgetStore`, `checkpointStore` or `pathBuilder`: a run whose evidence
 * and checkpoints die with the process does not leave its ledger on disk.
 */
export class InMemoryTokenBudgetStore implements TokenBudgetStore {
	private readonly records = new Map<string, TokenBudgetSnapshot>()

	private key(scope: TokenBudgetScope): string {
		const checked = validateScope(scope)
		return [checked.tenantId, checked.projectId, checked.sessionId, checked.runId].join('/')
	}

	async load(scope: TokenBudgetScope): Promise<TokenBudgetSnapshot | null> {
		const saved = this.records.get(this.key(scope))
		return saved === undefined ? null : structuredClone(saved)
	}

	async save(scope: TokenBudgetScope, snapshot: TokenBudgetSnapshot): Promise<void> {
		const key = this.key(scope)
		const checked = validateSnapshotScope(structuredClone(snapshot), validateScope(scope))
		const existing = this.records.get(key)
		if (existing) assertSameRoot(existing, checked)
		this.records.set(key, checked)
	}
}
