import {
	InMemorySessionTokenBudgetStore,
	type SessionId,
	type SessionTokenBudget,
	type TokenUsage,
	type TurnId,
	openSessionTokenBudget,
} from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { LABEL_REQUEST_ALLOWANCE_TOKENS, chargeLabelRequest } from '../label-ledger.js'

const sessionId = '4721e070-5ba2-425a-bf5a-8cc927907e9a' as SessionId
const turnId = '01999999-5ba2-7a25-bf5a-8cc927907e9a' as TurnId

function usage(promptTokens: number, completionTokens: number): TokenUsage {
	return {
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
}

async function ledger(limit: number): Promise<SessionTokenBudget> {
	const budget = await openSessionTokenBudget({
		store: new InMemorySessionTokenBudgetStore(),
		scope: { rootSessionId: sessionId, rootTurnId: turnId },
		limit,
	})
	budget.bindTurn(sessionId, turnId)
	return budget
}

function run(
	budget: SessionTokenBudget,
	request: () => Promise<{ value: string; usage: TokenUsage }>,
	signal = new AbortController().signal,
	estimatedPromptTokens = 500,
) {
	return chargeLabelRequest({ budget, sessionId, estimatedPromptTokens, signal, request })
}

describe('counting a label request on the turn’s ledger', () => {
	it('charges what the provider reported to an unlimited turn, and leaves nothing reserved', async () => {
		const budget = await ledger(0)
		const label = await run(budget, async () => ({
			value: 'Reading config',
			usage: usage(1_200, 12),
		}))
		expect(label).toBe('Reading config')
		const summary = budget.summary()
		expect(summary.treeTokens).toBe(1_212)
		expect(summary.ownTokens).toBe(0)
		expect(summary.unsettledChildren).toBe(0)
		expect(summary.poisoned).toBe(false)
	})

	it('charges a limited turn and hands the unspent allowance back', async () => {
		const budget = await ledger(50_000)
		await run(budget, async () => ({ value: 'x', usage: usage(1_000, 10) }))
		const summary = budget.summary()
		expect(summary.treeTokens).toBe(1_010)
		expect(summary.reservedTokens).toBe(0)
		expect(summary.remainingTokens).toBe(50_000 - 1_010)
	})

	it('reserves no more than the allowance from a limited turn while it runs', async () => {
		const budget = await ledger(500_000)
		let reservedWhileRunning = -1
		await run(budget, async () => {
			reservedWhileRunning = budget.summary().reservedTokens
			return { value: 'x', usage: usage(10, 1) }
		})
		expect(reservedWhileRunning).toBe(LABEL_REQUEST_ALLOWANCE_TOKENS)
	})

	it('skips the label when a limited turn has no room for it', async () => {
		const budget = await ledger(300)
		const request = vi.fn(async () => ({ value: 'x', usage: usage(1, 1) }))
		expect(await run(budget, request)).toBeUndefined()
		expect(request).not.toHaveBeenCalled()
		expect(budget.summary().treeTokens).toBe(0)
	})

	it('skips the label while the turn’s own request is in flight', async () => {
		const budget = await ledger(50_000)
		const rootRequest = await budget.beginRequest()
		const request = vi.fn(async () => ({ value: 'x', usage: usage(1, 1) }))
		expect(await run(budget, request)).toBeUndefined()
		expect(request).not.toHaveBeenCalled()
		await budget.finishRequest(rootRequest, usage(5, 5))
		expect(await run(budget, request)).toBe('x')
	})

	it('counts a failed request as nothing and does not stop the turn’s later requests', async () => {
		const budget = await ledger(50_000)
		await expect(
			run(budget, async () => {
				throw new Error('provider said no')
			}),
		).rejects.toThrow('provider said no')
		const summary = budget.summary()
		expect(summary.treeTokens).toBe(0)
		expect(summary.poisoned).toBe(false)
		expect(summary.unresolvedRequests).toBe(0)
		expect(summary.reservedTokens).toBe(0)
		const next = await budget.beginRequest()
		await budget.finishRequest(next, usage(1, 1))
	})

	it('counts a cancelled request as its estimated prompt, like the SDK does for one the person cancelled', async () => {
		const budget = await ledger(50_000)
		const controller = new AbortController()
		await expect(
			run(
				budget,
				async () => {
					controller.abort()
					throw new Error('aborted')
				},
				controller.signal,
				700,
			),
		).rejects.toThrow('aborted')
		const summary = budget.summary()
		expect(summary.treeTokens).toBe(700)
		expect(summary.poisoned).toBe(false)
	})
})
