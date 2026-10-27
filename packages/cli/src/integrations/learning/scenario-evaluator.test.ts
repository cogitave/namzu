import type { LearningEvaluationContext, LearningModel } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { createScenarioEvaluator } from './scenario-evaluator.js'
import { scenarioPlan } from './scenarios.js'

const context = (over: Partial<LearningEvaluationContext> = {}): LearningEvaluationContext => {
	const receipts: unknown[] = []
	return {
		cycleId: '11111111-1111-4111-8111-111111111111',
		stage: 'verification',
		signal: new AbortController().signal,
		remainingUnits: 1_000_000,
		recordUsage: async (r: unknown) => {
			receipts.push(r)
		},
		baseline: null,
		candidate: { name: 'session-guidance', description: 'd', body: 'RECOVER' },
		baselineRevision: 'none',
		candidateRevision: 'a'.repeat(64),
		...over,
	} as LearningEvaluationContext
}

const reply = (text: string, tokens: number | null = 5) => ({ text, tokens, costUsd: null })

describe('scenario evaluator', () => {
	it('grades both sides blind, in an order that varies, with a fresh marker each time', async () => {
		const grading: string[] = []
		const model: LearningModel = async (request) => {
			if (request.system.includes('You grade two replies')) {
				grading.push(request.prompt)
				return reply('{"a":{"pass":true,"reason":"ok"},"b":{"pass":true,"reason":"ok"}}')
			}
			return reply(request.system.includes('RECOVER') ? 'guided reply' : 'plain reply')
		}
		await createScenarioEvaluator({ plan: scenarioPlan(), model, route: 'r' })(context())
		expect(grading).toHaveLength(10)
		for (const prompt of grading) {
			expect(prompt).not.toMatch(/baseline|candidate guidance|with guidance/i)
		}
		const firstIsCandidate = grading.map((p) => /<reply_a [^>]*>\nguided reply/.test(p))
		expect(firstIsCandidate).toContain(true)
		expect(firstIsCandidate).toContain(false)
		const markers = grading.map((p) => /<request id="([0-9a-f]+)"/.exec(p)?.[1])
		expect(new Set(markers).size).toBe(markers.length)
	})

	it('keeps the same order when run again with the same cycle', async () => {
		const orders = async () => {
			const out: boolean[] = []
			const model: LearningModel = async (request) => {
				if (request.system.includes('You grade two replies')) {
					out.push(/<reply_a [^>]*>\nguided reply/.test(request.prompt))
					return reply('{"a":{"pass":true,"reason":"ok"},"b":{"pass":true,"reason":"ok"}}')
				}
				return reply(request.system.includes('RECOVER') ? 'guided reply' : 'plain reply')
			}
			await createScenarioEvaluator({ plan: scenarioPlan(), model, route: 'r' })(context())
			return out
		}
		expect(await orders()).toEqual(await orders())
	})

	it('records an unreadable grade as unavailable, not as a pass or a fail', async () => {
		const model: LearningModel = async (request) =>
			request.system.includes('You grade two replies') ? reply('I cannot decide.') : reply('x')
		const { batch } = await createScenarioEvaluator({ plan: scenarioPlan(), model, route: 'r' })(
			context(),
		)
		expect(batch.baseline.every((t) => t.result.status === 'inconclusive')).toBe(true)
		expect(batch.baseline.every((t) => t.result.scores.rubric?.unavailable === true)).toBe(true)
		expect(batch.attributions).toEqual([])
	})

	it('pairs every trial with matching conditions and distinct trajectories, fresh per round', async () => {
		const model: LearningModel = async (request) =>
			request.system.includes('You grade two replies')
				? reply('{"a":{"pass":true,"reason":"ok"},"b":{"pass":true,"reason":"ok"}}')
				: reply('x')
		const evaluate = createScenarioEvaluator({ plan: scenarioPlan(), model, route: 'r' })
		const first = (await evaluate(context())).batch
		const second = (await evaluate(context({ stage: 'confirmation' }))).batch
		expect(first.baseline.map((t) => t.conditions)).toEqual(
			first.candidate.map((t) => t.conditions),
		)
		expect(new Set(first.baseline.map((t) => t.conditions)).size).toBe(10)
		const seen = new Set(first.baseline.map((t) => t.conditions))
		expect(second.baseline.some((t) => seen.has(t.conditions))).toBe(false)
		const trajectories = [...first.baseline, ...first.candidate].map((t) => t.trajectoryId)
		expect(new Set(trajectories).size).toBe(20)
	})

	it('cites both sides when the candidate recovers a task', async () => {
		const model: LearningModel = async (request) => {
			if (request.system.includes('You grade two replies')) {
				const a = /<reply_a [^>]*>\n(.*)\n<\/reply_a>/.exec(request.prompt)?.[1]
				const b = /<reply_b [^>]*>\n(.*)\n<\/reply_b>/.exec(request.prompt)?.[1]
				const g = (x?: string) => ({ pass: x === 'good', reason: 'It names a step.' })
				return reply(JSON.stringify({ a: g(a), b: g(b) }))
			}
			return reply(request.system.includes('RECOVER') ? 'good' : 'bad')
		}
		const { batch } = await createScenarioEvaluator({ plan: scenarioPlan(), model, route: 'r' })(
			context(),
		)
		expect(batch.attributions).toHaveLength(5)
		for (const a of batch.attributions) {
			expect(a.effect).toBe('improvement')
			expect(a.baselineTrajectories).toHaveLength(2)
			expect(a.candidateTrajectories).toHaveLength(2)
		}
	})

	it('stops before the next call once the allowance is spent', async () => {
		const model: LearningModel = async () => reply('x', 100)
		await expect(
			createScenarioEvaluator({ plan: scenarioPlan(), model, route: 'r' })(
				context({ remainingUnits: 150 }),
			),
		).rejects.toThrow(/token allowance/)
	})
})
