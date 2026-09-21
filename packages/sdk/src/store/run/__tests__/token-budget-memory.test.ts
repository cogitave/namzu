import { describe, expect, it } from 'vitest'
import type { TokenBudgetSnapshot } from '../../../run/token-budget.js'
import type { TokenUsage } from '../../../types/common/index.js'
import type { TokenBudgetScope } from '../../../types/run/token-budget-store.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
} from '../../../utils/id.js'
import { openTokenBudget } from '../token-budget-disk.js'
import { InMemoryTokenBudgetStore } from '../token-budget-memory.js'

/**
 * The memory ledger answers like the disk one: a reopen sees what was spent,
 * and a record that would reduce spending or swap the root is refused.
 */

function usage(totalTokens: number): TokenUsage {
	return {
		promptTokens: totalTokens,
		completionTokens: 0,
		totalTokens,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
}

function scope(): TokenBudgetScope {
	return {
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		runId: generateRunId(),
	}
}

describe('InMemoryTokenBudgetStore', () => {
	it('reopens a ledger with the usage an earlier handle recorded', async () => {
		const store = new InMemoryTokenBudgetStore()
		const root = scope()
		const first = await openTokenBudget({ store, scope: root, limit: 1_000 })
		first.recordUsage(usage(300))
		await first.flush()

		const reopened = await openTokenBudget({
			store,
			scope: root,
			requireExisting: true,
		})
		expect(reopened.remaining).toBe(700)
	})

	it('is empty for a scope it never saw', async () => {
		const store = new InMemoryTokenBudgetStore()
		await expect(openTokenBudget({ store, scope: scope(), requireExisting: true })).rejects.toThrow(
			/missing/,
		)
	})

	it('refuses a record that reduces recorded usage', async () => {
		const store = new InMemoryTokenBudgetStore()
		const root = scope()
		const budget = await openTokenBudget({ store, scope: root, limit: 1_000 })
		const before = budget.snapshot()
		budget.recordUsage(usage(200))
		await budget.flush()
		await expect(store.save(root, before)).rejects.toThrow(/reduce/)
	})

	it('refuses a snapshot for another root run', async () => {
		const store = new InMemoryTokenBudgetStore()
		const root = scope()
		const budget = await openTokenBudget({ store, scope: root, limit: 1_000 })
		await expect(store.save(scope(), budget.snapshot())).rejects.toThrow(/root run mismatch/)
	})

	it('hands out copies, so a caller cannot edit what it holds', async () => {
		const store = new InMemoryTokenBudgetStore()
		const root = scope()
		await openTokenBudget({ store, scope: root, limit: 1_000 })
		const loaded = (await store.load(root)) as TokenBudgetSnapshot
		;(loaded.accounts[0] as { limit: number }).limit = 5
		const again = (await store.load(root)) as TokenBudgetSnapshot
		expect(again.accounts[0]?.limit).toBe(1_000)
	})
})
