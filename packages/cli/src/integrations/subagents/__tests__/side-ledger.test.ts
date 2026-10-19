import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	InMemorySessionTokenBudgetStore,
	MockLLMProvider,
	type SessionId,
	type SessionTokenBudgetSnapshot,
	type TokenUsage,
	type TurnId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

const used = (total: number): TokenUsage => ({
	promptTokens: total - 5,
	completionTokens: 5,
	totalTokens: total,
	cachedTokens: 0,
	cacheWriteTokens: 0,
})

async function setup() {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-side-ledger-'))
	dirs.push(cwd)
	const fixture = await subagentParentFixture(cwd)
	const store = new InMemorySessionTokenBudgetStore()
	const runtime = await createSubagentRuntime({
		cwd,
		model: 'mock',
		tokenBudgetStore: store,
		resolveParent: fixture.resolveParent,
		buildProvider: () => new MockLLMProvider({ turns: [{ text: 'done' }] }),
		buildTools: () => [],
	})
	const sessionId = fixture.scope.sessionId as SessionId
	const turnId = fixture.scope.turnId as TurnId
	/** Every token the ledger of this turn has been charged, across all its accounts. */
	const charged = async (): Promise<number> => {
		const snapshot: SessionTokenBudgetSnapshot | null = await store.load({
			rootSessionId: sessionId,
			rootTurnId: turnId,
		})
		if (!snapshot) return 0
		return snapshot.accounts.reduce(
			(sum, account) =>
				sum + Object.values(account.usage).reduce((inner, u) => inner + u.totalTokens, 0),
			0,
		)
	}
	return { runtime, sessionId, turnId, charged }
}

describe('counting requests made beside a turn', () => {
	it('counts a request run in the turn on the turn’s own ledger', async () => {
		const { runtime, sessionId, turnId, charged } = await setup()
		try {
			await runtime.gatewayForTurn(turnId)

			const value = await runtime.sideLedger.chargeNow({
				turnId,
				sessionId,
				estimatedPromptTokens: 100,
				signal: new AbortController().signal,
				request: async () => ({ value: 'answer', usage: used(300) }),
			})

			expect(value).toBe('answer')
			expect(await charged()).toBe(300)
		} finally {
			await runtime.close()
		}
	})

	it('runs nothing for a turn that has no ledger to count it on', async () => {
		const { runtime, sessionId, turnId } = await setup()
		try {
			let ran = false

			const value = await runtime.sideLedger.chargeNow({
				turnId,
				sessionId,
				estimatedPromptTokens: 100,
				signal: new AbortController().signal,
				request: async () => {
					ran = true
					return { value: 'answer', usage: used(300) }
				},
			})

			expect(value).toBeUndefined()
			expect(ran).toBe(false)
		} finally {
			await runtime.close()
		}
	})

	it('holds the count of a request made beside the turn until the turn is released', async () => {
		const { runtime, sessionId, turnId, charged } = await setup()
		try {
			await runtime.gatewayForTurn(turnId)

			runtime.sideLedger.chargeLater({
				turnId,
				sessionId,
				estimatedPromptTokens: 100,
				usage: used(120),
			})
			expect(await charged()).toBe(0)

			await runtime.releaseTurn(turnId)

			expect(await charged()).toBe(120)
		} finally {
			await runtime.close()
		}
	})

	it('counts a request that finishes after its turn was released', async () => {
		const { runtime, sessionId, turnId, charged } = await setup()
		try {
			await runtime.gatewayForTurn(turnId)
			await runtime.releaseTurn(turnId)

			await runtime.sideLedger.chargeLater({
				turnId,
				sessionId,
				estimatedPromptTokens: 100,
				usage: used(80),
			})

			expect(await charged()).toBe(80)
		} finally {
			await runtime.close()
		}
	})
})
