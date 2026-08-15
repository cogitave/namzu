import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateThreadId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * Every run reported a cost of `$0.00`.
 *
 * `calculateCost` existed, `CostInfo` was carried on the run, the step, the
 * checkpoint and the `token_usage_updated` event — and nothing supplied a rate
 * to any of it. `RunPersistence` priced a turn only when the host passed
 * `pricing` to `query()`; `ReactiveAgent` does not forward that field, and
 * `@namzu/cli` never sets it, so the accumulation branch was dead on every
 * shipped surface.
 *
 * These are reachability tests, not arithmetic ones: the arithmetic is
 * exercised in `utils/__tests__/cost-arithmetic.test.ts`, and passing there
 * proves nothing about whether a run ever reaches it. Before the price
 * catalogue, every case below reported zero.
 */

registerMock()

/**
 * The mock, wearing a driver's identity.
 *
 * The rate lookup is keyed on `LLMProvider.id`, and `MockLLMProvider` reports
 * `'mock'` — which is in no rate card, correctly. Delegating rather than
 * subclassing keeps the scripted stream exactly as the mock produces it, so
 * what is under test is the lookup and the plumbing, not a second fake.
 */
class ProviderWearing implements LLMProvider {
	readonly name = 'delegating provider'
	constructor(
		readonly id: string,
		private readonly inner: MockLLMProvider,
	) {}
	chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		return this.inner.chatStream(params)
	}
}

const USAGE = { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 }

function run(opts: {
	providerId: string
	model: string
	costLimitUsd?: number
	usage?: Partial<typeof USAGE>
	maxIterations?: number
	tokenBudget?: number
	withEchoTool?: boolean
	turns?: {
		text?: string
		usage?: Partial<typeof USAGE>
		error?: { message: string }
		toolCalls?: { name: string; args: Record<string, unknown> }[]
	}[]
	fallbackProviders?: { provider: LLMProvider; model?: string }[]
}) {
	const tools = new ToolRegistry()
	if (opts.withEchoTool) {
		tools.register({
			name: 'echo',
			description: 'echo the text back',
			inputSchema: z.object({ text: z.string() }),
			execute: async () => ({ success: true, output: 'hi' }),
		})
	}
	const provider = new ProviderWearing(
		opts.providerId,
		new MockLLMProvider({
			model: opts.model,
			turns: opts.turns ?? [{ text: 'done', usage: { ...USAGE, ...opts.usage } }],
		}),
	)

	return drainQuery({
		provider,
		...(opts.fallbackProviders ? { fallbackProviders: opts.fallbackProviders } : {}),
		retry: false,
		tools,
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'hello' }],
		workingDirectory: process.cwd(),
		runConfig: {
			model: opts.model,
			tokenBudget: opts.tokenBudget ?? 100_000_000,
			timeoutMs: 30_000,
			maxIterations: opts.maxIterations ?? 2,
			...(opts.costLimitUsd === undefined ? {} : { costLimitUsd: opts.costLimitUsd }),
		},
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateThreadId(),
		tenantId: generateTenantId(),
	})
}

describe('a run against a catalogued model', () => {
	it('reports a non-zero cost with no host-supplied pricing table', async () => {
		const settled = await run({ providerId: 'anthropic', model: 'claude-opus-5' })

		// 1M input at $5 + 1M output at $25.
		expect(settled.costInfo.totalCost).toBeCloseTo(30, 6)
		expect(settled.costInfo.unpricedTokens).toBe(0)
		// Not merely non-zero — the RIGHT non-zero. A test asserting only
		// `> 0` would pass against any rate at all, including a wrong one.
		expect(settled.costInfo.inputCostPer1M).toBe(5)
	})

	it('prices from the model actually asked for, not from the run alone', async () => {
		const cheap = await run({ providerId: 'anthropic', model: 'claude-haiku-4-5' })
		const dear = await run({ providerId: 'anthropic', model: 'claude-opus-5' })
		expect(cheap.costInfo.totalCost).toBeLessThan(dear.costInfo.totalCost)
	})

	it('prices a turn at the rate of the member that SERVED it, not the one declared', async () => {
		// Every other case here runs a single provider on the run's own model,
		// where "priced per turn against who answered" and "priced once against
		// runConfig.model" give the same number — so none of them can tell the
		// two apart. Deleting the per-turn attribution and reading
		// `runConfig.model` instead passed all of them.
		//
		// A chain that falls over separates the two: the head is asked for the
		// dearer model at $5/$25 and fails, and the member that actually
		// answers declares a cheaper one at $1/$5.
		const settled = await run({
			providerId: 'anthropic',
			model: 'claude-opus-5',
			turns: [{ error: { message: 'head is down' } }],
			fallbackProviders: [
				{
					provider: new ProviderWearing(
						'anthropic',
						new MockLLMProvider({
							model: 'claude-haiku-4-5',
							turns: [{ text: 'done', usage: USAGE }],
						}),
					),
					model: 'claude-haiku-4-5',
				},
			],
		})

		// 1M in at $1 + 1M out at $5. Priced at the head's card it would be $30.
		expect(settled.costInfo.totalCost).toBeCloseTo(6, 6)
		expect(settled.costInfo.inputCostPer1M).toBe(1)
	})

	it('prices the closing summary too, when a guard forces one', async () => {
		// `requestFinalResponse` is a real model call on a path of its own: it
		// fires after a hard stop, has no `servedBy` to read, and asks
		// `runMgr.servingProviderId` instead. Nothing else here reaches it, so
		// without this case that call could be attributed to no model at all —
		// or to an empty provider id — and every other assertion would hold.
		// The turn asks for a tool, so the loop wants another iteration — and a
		// token budget the first turn already blew through means the guard
		// hard-stops instead and asks for a closing summary. A turn that simply
		// answered would end on `end_turn` and never reach the guard.
		const settled = await run({
			providerId: 'anthropic',
			model: 'claude-opus-5',
			tokenBudget: 1_000,
			maxIterations: 10,
			withEchoTool: true,
			turns: [
				{
					toolCalls: [{ name: 'echo', args: { text: 'hi' } }],
					usage: { promptTokens: 1_000, completionTokens: 1_000, totalTokens: 2_000 },
				},
			],
		})

		expect(settled.stopReason).toBe('token_budget')
		expect(settled.costInfo.unpricedTokens).toBe(0)
		// Two calls, both priced: the turn and the forced summary.
		expect(settled.tokenUsage.totalTokens).toBe(4_000)
		expect(settled.costInfo.totalCost).toBeCloseTo(0.06, 6)
	})

	it('reports a genuinely free run as free, not as unknown', async () => {
		const settled = await run({ providerId: 'ollama', model: 'llama3.1:8b' })
		expect(settled.costInfo.totalCost).toBe(0)
		// The distinction. A local run costs nothing and we know it; the case
		// below costs something and we do not.
		expect(settled.costInfo.unpricedTokens).toBe(0)
	})
})

describe('a run against a model nobody has a rate for', () => {
	it('reports unknown, distinctly from free', async () => {
		const unknown = await run({ providerId: 'mock', model: 'mock' })
		const free = await run({ providerId: 'ollama', model: 'llama3.1:8b' })

		expect(unknown.costInfo.totalCost).toBe(0)
		expect(unknown.costInfo.unpricedTokens).toBeGreaterThan(0)

		// The assertion that matters. Both totals are zero, so a test checking
		// `totalCost === 0` passes against the defect being fixed; the two runs
		// have to be distinguishable, and this is where they are.
		expect(unknown.costInfo).not.toEqual(free.costInfo)
		expect(unknown.costInfo.unpricedTokens).not.toBe(free.costInfo.unpricedTokens)
	})

	it('claims no rate card for a total it could not compute', async () => {
		const settled = await run({ providerId: 'mock', model: 'mock' })
		expect(settled.costInfo.inputCostPer1M).toBeUndefined()
		expect(settled.costInfo.outputCostPer1M).toBeUndefined()
	})
})

describe('costLimitUsd when the cost cannot be measured', () => {
	it('refuses the run up front rather than running it unbudgeted', async () => {
		// The defect underneath all of this: a limit enforced against a total
		// that never moves is a limit that never fires, and nothing said so.
		await expect(run({ providerId: 'mock', model: 'mock', costLimitUsd: 5 })).rejects.toThrow(
			/no rate is known/i,
		)
	})

	it('names the model and the provider, so the fix is one edit away', async () => {
		const failure = await run({
			providerId: 'mock',
			model: 'some-unpriced-model',
			costLimitUsd: 5,
		}).catch((error: Error) => error)

		expect(failure).toBeInstanceOf(Error)
		expect((failure as Error).message).toContain('some-unpriced-model')
		expect((failure as Error).message).toContain('mock')
	})

	it('allows the same limit when the model is priced', async () => {
		// The refusal has to be about measurability, not about `costLimitUsd`
		// existing. Without this, deleting the catalogue lookup from the
		// preflight and always throwing would still pass the case above.
		const settled = await run({
			providerId: 'anthropic',
			model: 'claude-opus-5',
			costLimitUsd: 1_000,
			usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
		})
		expect(settled.stopReason).not.toBe('cost_unmeasurable')
		expect(settled.costInfo.totalCost).toBeGreaterThan(0)
	})

	it('does not refuse a run that set no limit', async () => {
		// An unpriced model is only a problem for a budget. A run without one
		// is entitled to proceed and report honestly that it does not know.
		const settled = await run({ providerId: 'mock', model: 'mock' })
		expect(settled.costInfo.unpricedTokens).toBeGreaterThan(0)
	})
})
