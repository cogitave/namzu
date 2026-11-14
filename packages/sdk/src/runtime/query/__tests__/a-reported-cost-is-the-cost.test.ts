import { describe, expect, it } from 'vitest'

import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import {
	type TokenUsage,
	accumulateTokenUsage,
	mergeTokenUsage,
} from '../../../types/common/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	ProviderCapabilities,
	StreamChunk,
} from '../../../types/provider/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * A model through a gateway whose id has no price row was recorded as
 * `totalCost: 0` with every token unpriced, although the gateway states what
 * each request was charged. The charge the provider reports is the cost; the
 * rate card is only the fallback.
 */

registerMock()

class ProviderWearing implements LLMProvider {
	readonly name = 'delegating provider'
	constructor(
		readonly id: string,
		private readonly inner: MockLLMProvider,
		readonly capabilities?: ProviderCapabilities,
	) {}
	chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		return this.inner.chatStream(params)
	}
}

const CAPS: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	reportsRequestCost: true,
}

function run(opts: {
	providerId: string
	model: string
	usage: Partial<TokenUsage>
	reportsCost?: boolean
	costLimitUsd?: number
}) {
	const provider = new ProviderWearing(
		opts.providerId,
		new MockLLMProvider({ model: opts.model, turns: [{ text: 'done', usage: opts.usage }] }),
		opts.reportsCost ? CAPS : undefined,
	)
	return drainQuery({
		provider,
		retry: false,
		toolsets: [testToolset()],
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'hello' }],
		workingDirectory: process.cwd(),
		turnConfig: {
			model: opts.model,
			tokenBudget: 100_000_000,
			timeoutMs: 30_000,
			maxIterations: 2,
			...(opts.costLimitUsd === undefined ? {} : { costLimitUsd: opts.costLimitUsd }),
		},
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
	})
}

const TOKENS = { promptTokens: 40_000, completionTokens: 500, totalTokens: 40_500 }

describe('a cost the provider reported', () => {
	it('is the cost of a model with no rate row, and leaves no unpriced tokens', async () => {
		const settled = await run({
			providerId: 'openrouter',
			model: 'deepseek/deepseek-v4.1-flash-1017',
			usage: { ...TOKENS, reportedCostUsd: 0.0123 },
			reportsCost: true,
		})
		expect(settled.costInfo.totalCost).toBeCloseTo(0.0123, 10)
		expect(settled.costInfo.unpricedTokens).toBe(0)
	})

	it('wins over the rate card of a model that has one', async () => {
		const settled = await run({
			providerId: 'anthropic',
			model: 'claude-opus-5',
			usage: {
				promptTokens: 1_000_000,
				completionTokens: 1_000_000,
				totalTokens: 2_000_000,
				reportedCostUsd: 0.5,
			},
		})
		// The card would say 30.
		expect(settled.costInfo.totalCost).toBeCloseTo(0.5, 10)
	})

	it('falls back to the card when the call reported nothing', async () => {
		const settled = await run({
			providerId: 'anthropic',
			model: 'claude-opus-5',
			usage: { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 },
		})
		expect(settled.costInfo.totalCost).toBeCloseTo(30, 6)
	})

	it('still leaves a model with no row and no report unpriced', async () => {
		const settled = await run({
			providerId: 'openrouter',
			model: 'deepseek/deepseek-v4.1-flash-1017',
			usage: TOKENS,
		})
		expect(settled.costInfo.totalCost).toBe(0)
		expect(settled.costInfo.unpricedTokens).toBe(40_500)
	})

	it('lets a cost limit be set for a provider that reports cost, and enforces it', async () => {
		const settled = await run({
			providerId: 'openrouter',
			model: 'deepseek/deepseek-v4.1-flash-1017',
			usage: { ...TOKENS, reportedCostUsd: 0.5 },
			reportsCost: true,
			costLimitUsd: 0.1,
		})
		expect(settled.costInfo.totalCost).toBeCloseTo(0.5, 10)
	})

	it('still refuses a cost limit for an unknown model on a provider that does not report', async () => {
		await expect(
			run({
				providerId: 'openrouter',
				model: 'deepseek/deepseek-v4.1-flash-1017',
				usage: TOKENS,
				costLimitUsd: 0.1,
			}),
		).rejects.toThrow(/no rate is known/)
	})
})

describe('the reported cost across calls and frames', () => {
	const base = {
		promptTokens: 1,
		completionTokens: 1,
		totalTokens: 2,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
	it('sums over calls, only when someone reported', () => {
		expect(accumulateTokenUsage({ ...base }, { ...base }).reportedCostUsd).toBeUndefined()
		expect(
			accumulateTokenUsage({ ...base, reportedCostUsd: 0.1 }, { ...base, reportedCostUsd: 0.2 })
				.reportedCostUsd,
		).toBeCloseTo(0.3, 10)
		expect(
			accumulateTokenUsage({ ...base, reportedCostUsd: 0.1 }, { ...base }).reportedCostUsd,
		).toBe(0.1)
	})
	it('takes the larger report among frames of one call', () => {
		expect(mergeTokenUsage({ ...base }, { ...base, reportedCostUsd: 0.2 }).reportedCostUsd).toBe(
			0.2,
		)
		expect(mergeTokenUsage({ ...base, reportedCostUsd: 0.2 }, { ...base }).reportedCostUsd).toBe(
			0.2,
		)
	})
})
