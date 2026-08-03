import { describe, expect, it, vi } from 'vitest'

import type { AdvisorDefinition, AdvisoryCallRecord } from '../../types/advisory/index.js'
import type { StreamChunk } from '../../types/provider/index.js'
import { assertBudgetEnforceable } from '../budget.js'
import { AdvisoryContext } from '../context.js'
import { TriggerEvaluator } from '../evaluator.js'
import { AdvisoryExecutor } from '../executor.js'
import { AdvisorRegistry } from '../registry.js'

/**
 * `AdvisoryBudget` declared six caps and enforced one. The other five were
 * read by nothing: a host could set `maxCostPerRun` and watch an advisor
 * spend without limit, and the only signal that the cap was inert was that
 * nothing ever happened.
 *
 * Two of the six could not be honoured at all — the advisory stack is built
 * per run, so a per-SESSION cap had no accumulator to count against — and
 * those were removed rather than left as decoration. What remains is
 * enforced here.
 */

function record(cost: number): AdvisoryCallRecord {
	return {
		advisorId: 'a',
		request: { question: 'q' },
		result: { advice: '' },
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		cost: { inputCostPer1M: 0, outputCostPer1M: 0, totalCost: cost, cacheDiscount: 0 },
		durationMs: 1,
		iteration: 1,
		timestamp: 0,
	}
}

function contextWith(budget: Parameters<typeof assertBudgetEnforceable>[0]['budget']) {
	return new AdvisoryContext(
		new AdvisorRegistry([]),
		new AdvisoryExecutor(),
		new TriggerEvaluator([]),
		budget,
	)
}

describe('a per-run cost cap actually stops the next call', () => {
	it('allows a call while the accumulated cost is under the cap', () => {
		const ctx = contextWith({ maxCostPerRun: 1 })
		ctx.recordCall(record(0.4))
		expect(ctx.checkBudget().allowed).toBe(true)
	})

	it('refuses once the accumulated cost reaches the cap', () => {
		const ctx = contextWith({ maxCostPerRun: 1 })
		ctx.recordCall(record(0.6))
		ctx.recordCall(record(0.5))

		const verdict = ctx.checkBudget()
		expect(verdict.allowed).toBe(false)
		// The operator gets the number they set and the number they hit;
		// "budget exhausted" alone leaves them guessing which cap tripped.
		expect(verdict.reason).toContain('1.1')
		expect(verdict.reason).toContain('cost')
	})

	it('leaves the call cap working alongside it', () => {
		const ctx = contextWith({ maxCallsPerRun: 1 })
		ctx.recordCall(record(0))
		expect(ctx.checkBudget().allowed).toBe(false)
	})
})

describe('a cost cap without pricing is refused, not silently inert', () => {
	const advisor = (pricing?: { inputCostPer1M: number; outputCostPer1M: number }) =>
		({
			id: 'a',
			name: 'A',
			model: 'm',
			provider: {} as AdvisorDefinition['provider'],
			...(pricing ? { pricing } : {}),
		}) as AdvisorDefinition

	it('throws when a cost cap is set and an advisor carries no pricing', () => {
		expect(() =>
			assertBudgetEnforceable({ advisors: [advisor()], budget: { maxCostPerRun: 5 } }),
		).toThrow(/pricing/i)
	})

	it('accepts the same cap once pricing is supplied', () => {
		expect(() =>
			assertBudgetEnforceable({
				advisors: [advisor({ inputCostPer1M: 1, outputCostPer1M: 2 })],
				budget: { maxCostPerRun: 5 },
			}),
		).not.toThrow()
	})

	it('says nothing about pricing when no cost cap is set', () => {
		expect(() =>
			assertBudgetEnforceable({ advisors: [advisor()], budget: { maxCallsPerRun: 2 } }),
		).not.toThrow()
	})
})

describe('a per-call token cap reaches the provider', () => {
	function providerCapturing(seen: { maxTokens?: number }) {
		return {
			chatStream: vi.fn(async function* (params: {
				maxTokens?: number
			}): AsyncGenerator<StreamChunk> {
				seen.maxTokens = params.maxTokens
				yield { id: 'r', delta: { content: 'ok' } } as StreamChunk
				yield {
					id: 'r',
					delta: {},
					finishReason: 'stop',
					usage: {
						promptTokens: 1,
						completionTokens: 1,
						totalTokens: 2,
						cachedTokens: 0,
						cacheWriteTokens: 0,
					},
				} as StreamChunk
			}),
		} as unknown as AdvisorDefinition['provider']
	}

	it('clamps an advisor that asks for more than the budget allows', async () => {
		const seen: { maxTokens?: number } = {}
		const exec = new AdvisoryExecutor(undefined, { maxTokensPerCall: 100 })
		await exec.consult(
			{
				id: 'a',
				name: 'A',
				model: 'm',
				provider: providerCapturing(seen),
				maxResponseTokens: 5000,
			},
			{ question: 'q' },
			{ messages: [], iteration: 1 },
		)
		expect(seen.maxTokens).toBe(100)
	})

	it('applies the cap to an advisor that names no ceiling of its own', async () => {
		const seen: { maxTokens?: number } = {}
		const exec = new AdvisoryExecutor(undefined, { maxTokensPerCall: 100 })
		await exec.consult(
			{ id: 'a', name: 'A', model: 'm', provider: providerCapturing(seen) },
			{ question: 'q' },
			{ messages: [], iteration: 1 },
		)
		expect(seen.maxTokens).toBe(100)
	})

	it('leaves a smaller advisor ceiling alone', async () => {
		const seen: { maxTokens?: number } = {}
		const exec = new AdvisoryExecutor(undefined, { maxTokensPerCall: 100 })
		await exec.consult(
			{ id: 'a', name: 'A', model: 'm', provider: providerCapturing(seen), maxResponseTokens: 40 },
			{ question: 'q' },
			{ messages: [], iteration: 1 },
		)
		expect(seen.maxTokens).toBe(40)
	})
})

describe('cost is real when the advisor carries pricing', () => {
	it('computes from the advisor pricing rather than reporting zero', async () => {
		const provider = {
			chatStream: vi.fn(async function* (): AsyncGenerator<StreamChunk> {
				yield { id: 'r', delta: { content: 'ok' } } as StreamChunk
				yield {
					id: 'r',
					delta: {},
					finishReason: 'stop',
					usage: {
						promptTokens: 1_000_000,
						completionTokens: 1_000_000,
						totalTokens: 2_000_000,
						cachedTokens: 0,
						cacheWriteTokens: 0,
					},
				} as StreamChunk
			}),
		} as unknown as AdvisorDefinition['provider']

		const exec = new AdvisoryExecutor()
		const out = await exec.consult(
			{
				id: 'a',
				name: 'A',
				model: 'm',
				provider,
				pricing: { inputCostPer1M: 3, outputCostPer1M: 15 },
			},
			{ question: 'q' },
			{ messages: [], iteration: 1 },
		)
		expect(out.cost.totalCost).toBe(18)
	})
})
