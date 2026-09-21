import {
	type SessionTokenBudgetStore,
	assertSameRoot,
	validateBudgetScope,
	validateSnapshotScope,
} from './disk.js'
import type { SessionTokenBudgetScope, SessionTokenBudgetSnapshot } from './ledger.js'

/**
 * Process-local {@link SessionTokenBudgetStore}: one ledger per
 * `(rootSessionId, rootTurnId)`, no filesystem.
 *
 * It refuses exactly what the disk store refuses (a snapshot for another
 * key, a replaced root account, reduced usage, a forgotten receipt), so a
 * host that tests against one and ships the other sees the same answers.
 * Records are copied on the way in and out, so a caller holding a snapshot
 * cannot change what the store holds.
 */
export class InMemorySessionTokenBudgetStore implements SessionTokenBudgetStore {
	readonly #records = new Map<string, SessionTokenBudgetSnapshot>()

	#key(scope: SessionTokenBudgetScope): string {
		const checked = validateBudgetScope(scope)
		return `${checked.rootSessionId}/${checked.rootTurnId}`
	}

	async load(scope: SessionTokenBudgetScope): Promise<SessionTokenBudgetSnapshot | null> {
		const saved = this.#records.get(this.#key(scope))
		return saved === undefined ? null : structuredClone(saved)
	}

	async save(scope: SessionTokenBudgetScope, snapshot: SessionTokenBudgetSnapshot): Promise<void> {
		const key = this.#key(scope)
		const checked = validateSnapshotScope(structuredClone(snapshot), validateBudgetScope(scope))
		const existing = this.#records.get(key)
		if (existing) assertSameRoot(existing, checked)
		this.#records.set(key, checked)
	}
}
