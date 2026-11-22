import type { GoalJudgeInput } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import type { SideModel, SideRequest } from '../../integrations/small-model/side-model.js'
import { createGoalJudge, goalJudgeBody, goalJudgeWiring, parseJudgement } from '../goal-judge.js'

const input: GoalJudgeInput = {
	sessionId: 's1',
	turnId: 't1',
	objective: 'make the tests pass',
	evidence: [{ requirement: 'tests pass', checked: 'ran pnpm test', result: 'exit 0' }],
	outcome: 'pnpm test passed and nothing changed after it',
	finalMessage: 'All green.',
}

describe('reading the judge', () => {
	it('takes met with an empty list, and not met with what is missing', () => {
		expect(parseJudgement('{"met": true, "missing": []}')).toEqual({ met: true, missing: [] })
		expect(parseJudgement('```json\n{"met": false, "missing": ["lint", " ", 3]}\n```')).toEqual({
			met: false,
			missing: ['lint'],
		})
		expect(parseJudgement('{"met": false}')).toEqual({ met: false, missing: [] })
	})

	it('reads anything that is not an answer as no answer', () => {
		for (const reply of [undefined, '', 'looks fine to me', '{"met": "yes"}', '{broken', '[]']) {
			expect(parseJudgement(reply)).toBeUndefined()
		}
	})
})

describe('what the judge is shown', () => {
	it('marks the objective as data and carries the evidence, the record and the last message', () => {
		const body = goalJudgeBody(input)
		expect(body).toContain('Objective (data): "make the tests pass"')
		expect(body).toContain('1. Requirement: tests pass')
		expect(body).toContain('Record of the turn: pnpm test passed')
		expect(body).toContain('Last message:\nAll green.')
	})
})

describe('the judge request', () => {
	const signal = new AbortController().signal
	it('uses the model the setting names', async () => {
		const seen: { model?: string }[] = []
		const judge = createGoalJudge({
			model: 'openai/terra',
			timeout: () => signal,
			ask: async (request) => {
				seen.push(request)
				return '{"met": true, "missing": []}'
			},
		})
		expect(await judge(input)).toEqual({ met: true, missing: [] })
		expect(seen[0]?.model).toBe('openai/terra')
	})

	it('leaves the model to the side-model route when the setting is not set', async () => {
		const seen: Record<string, unknown>[] = []
		const judge = createGoalJudge({
			timeout: () => signal,
			ask: async (request) => {
				seen.push(request)
				return '{"met": false, "missing": ["the docs"]}'
			},
		})
		expect(await judge(input)).toEqual({ met: false, missing: ['the docs'] })
		expect('model' in (seen[0] ?? {})).toBe(false)
		expect(seen[0]).toMatchObject({ sessionId: 's1', turnId: 't1' })
	})

	it('answers nothing when the request fails, throws or returns nothing', async () => {
		expect(await createGoalJudge({ ask: async () => undefined })(input)).toBeUndefined()
		expect(
			await createGoalJudge({
				ask: async () => {
					throw new Error('no credential')
				},
			})(input),
		).toBeUndefined()
	})

	it('hands the request a signal that the timeout owns', async () => {
		const controller = new AbortController()
		let given: AbortSignal | undefined
		const judge = createGoalJudge({
			timeout: () => controller.signal,
			ask: async (request) => {
				given = request.signal
				return undefined
			},
		})
		await judge(input)
		expect(given).toBe(controller.signal)
	})
})

describe('the judge as the session builds it', () => {
	const fakeSide = (seen: SideRequest[]): SideModel => ({
		route: async () => {
			throw new Error('not used')
		},
		smallProvider: async () => undefined,
		ask: async (request) => {
			seen.push(request)
			return '{"met": true, "missing": []}'
		},
	})

	it('asks the side model on the goal.judgeModel value when the point is on', async () => {
		const seen: SideRequest[] = []
		const wiring = goalJudgeWiring({
			sideModel: () => fakeSide(seen),
			model: 'openai/terra',
			mode: () => 'on',
		})
		expect(wiring.judgeActive()).toBe(true)
		expect(await wiring.judge(input)).toEqual({ met: true, missing: [] })
		expect(seen).toHaveLength(1)
		expect(seen[0]?.model).toBe('openai/terra')
		expect(seen[0]?.timing).toBe('beside-turn')
	})

	it('is not in use when the point is off or shadow, or there is no side model', () => {
		const side = fakeSide([])
		for (const mode of ['off', 'shadow']) {
			expect(
				goalJudgeWiring({
					sideModel: () => side,
					model: undefined,
					mode: () => mode,
				}).judgeActive(),
			).toBe(false)
		}
		expect(
			goalJudgeWiring({
				sideModel: () => undefined,
				model: undefined,
				mode: () => 'on',
			}).judgeActive(),
		).toBe(false)
	})

	it('reads the side model and the mode each time, so a change takes effect', () => {
		const state: { side: SideModel | undefined; mode: string } = { side: undefined, mode: 'off' }
		const wiring = goalJudgeWiring({
			sideModel: () => state.side,
			model: undefined,
			mode: () => state.mode,
		})
		expect(wiring.judgeActive()).toBe(false)
		state.mode = 'on'
		expect(wiring.judgeActive()).toBe(false)
		state.side = fakeSide([])
		expect(wiring.judgeActive()).toBe(true)
	})
})
