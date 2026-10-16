import { describe, expect, it } from 'vitest'
import {
	DECIDE_TOOL_NAME,
	DecisionError,
	type DecisionModel,
	createDecisionTool,
} from '../index.js'

/** A DecisionModel whose three methods are driven by the test. */
function stub(overrides: Partial<DecisionModel>): DecisionModel {
	const reject = async () => {
		throw new Error('not configured for this test')
	}
	return {
		yesno: overrides.yesno ?? (reject as DecisionModel['yesno']),
		choice: overrides.choice ?? (reject as DecisionModel['choice']),
		score: overrides.score ?? (reject as DecisionModel['score']),
	}
}

// Execute only reads `context.abortSignal`; a bare object is enough.
const ctx = {} as any

describe('createDecisionTool', () => {
	it('is named `decide` by default', () => {
		const tool = createDecisionTool(stub({}))
		expect(tool.name).toBe(DECIDE_TOOL_NAME)
	})

	it('honours a name override', () => {
		expect(createDecisionTool(stub({}), { name: 'judge' }).name).toBe('judge')
	})

	it('yesno surfaces P(true) and the structured result', async () => {
		const tool = createDecisionTool(stub({ yesno: async () => ({ p: 0.97 }) }))
		const r = await tool.execute({ kind: 'yesno', context: 's', question: 'danger?' }, ctx)
		expect(r.success).toBe(true)
		expect(r.output).toContain('0.9700')
		expect(r.data).toEqual({ kind: 'yesno', p: 0.97 })
	})

	it('choice surfaces the pick and distribution', async () => {
		const tool = createDecisionTool(
			stub({
				choice: (async () => ({
					option: 'e4',
					probabilities: { e1: 0.1, e4: 0.9 },
				})) as DecisionModel['choice'],
			}),
		)
		const r = await tool.execute(
			{ kind: 'choice', context: 's', question: 'pick', options: ['e1', 'e4'] },
			ctx,
		)
		expect(r.success).toBe(true)
		expect(r.output).toContain('e4')
		expect(r.data).toMatchObject({ kind: 'choice', option: 'e4' })
	})

	it('score names the chosen level', async () => {
		const tool = createDecisionTool(
			stub({ score: async () => ({ level: 1, probabilities: [0.2, 0.8] }) }),
		)
		const r = await tool.execute(
			{ kind: 'score', context: 's', question: 'rate', levels: ['low', 'high'] },
			ctx,
		)
		expect(r.success).toBe(true)
		expect(r.output).toContain('high')
		expect(r.data).toMatchObject({ kind: 'score', level: 1, name: 'high' })
	})

	it('needs 2+ options for choice without calling the model', async () => {
		let called = false
		const tool = createDecisionTool(
			stub({
				choice: (async () => {
					called = true
					return { option: 'a', probabilities: { a: 1 } }
				}) as DecisionModel['choice'],
			}),
		)
		const r = await tool.execute(
			{ kind: 'choice', context: 's', question: 'pick', options: ['a'] },
			ctx,
		)
		expect(called).toBe(false)
		expect(r.success).toBe(true)
		expect(r.output).toContain('2 or more')
	})

	it('FAIL-OPEN: a model error becomes a successful "unavailable" result, never a failure', async () => {
		const tool = createDecisionTool(
			stub({
				yesno: async () => {
					throw new DecisionError('rate limited', 429, 'TooManyRequests')
				},
			}),
		)
		const r = await tool.execute({ kind: 'yesno', context: 's', question: 'q' }, ctx)
		expect(r.success).toBe(true)
		expect(r.output).toContain('unavailable')
		expect(r.output).toContain('rate limited')
		expect(r.data).toMatchObject({ kind: 'unavailable' })
	})

	it('FAIL-OPEN: a non-DecisionError throw is also absorbed', async () => {
		const tool = createDecisionTool(
			stub({
				yesno: async () => {
					throw new TypeError('fetch failed')
				},
			}),
		)
		const r = await tool.execute({ kind: 'yesno', context: 's', question: 'q' }, ctx)
		expect(r.success).toBe(true)
		expect(r.output).toContain('unavailable')
	})
})
