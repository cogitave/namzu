import type { DecisionModel } from '@namzu/decision'
import { describe, expect, it, vi } from 'vitest'
import { MEMORY_ADMIT_CRITERIA, memoryAdmitQuestion } from '../memory.js'
import { NOTIFY_WORTHY_CRITERIA, notifyWorthyQuestion } from '../notify.js'
import { createDecisionPoints } from '../points.js'
import { ROUTING_BIG_CRITERIA, ROUTING_FAST_CRITERIA } from '../routing.js'
import { SKILL_WORTHY_CRITERIA, skillWorthyQuestion } from '../skill.js'

const EMPTY = {
	userRequirements: [],
	decisions: [],
	discoveries: [],
	failures: [],
	environment: [],
}

describe('yes/no decision points carry criteria', () => {
	it('every point question names what makes the answer yes', () => {
		const questions = [
			notifyWorthyQuestion({ reply: 'Done?', turnMs: 1000, rule: true }),
			memoryAdmitQuestion({
				...EMPTY,
				task: 'tabs',
				decisions: ['Use tabs.'],
			} as never),
			skillWorthyQuestion({ request: 'prepare a release', tools: ['bash'], steps: 4 }),
		]
		for (const q of questions) {
			expect(q.criteria?.length ?? 0).toBeGreaterThan(40)
			expect(q.criteria).toMatch(/^Yes /)
		}
		expect(questions[0]?.criteria).toBe(NOTIFY_WORTHY_CRITERIA)
		expect(questions[1]?.criteria).toBe(MEMORY_ADMIT_CRITERIA)
		expect(questions[2]?.criteria).toBe(SKILL_WORTHY_CRITERIA)
		expect(ROUTING_FAST_CRITERIA).toMatch(/^Yes /)
		expect(ROUTING_BIG_CRITERIA).toMatch(/^Yes /)
	})

	it('ask hands the criteria to the model', async () => {
		const yesno = vi.fn(async () => ({ p: 0.9 }))
		const points = createDecisionPoints({
			model: { yesno } as unknown as DecisionModel,
			modes: { notify: 'on' },
			log: () => {},
		})
		await points.ask(notifyWorthyQuestion({ reply: 'Ready?', turnMs: 1000, rule: true }))
		expect(yesno).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			expect.objectContaining({ criteria: NOTIFY_WORTHY_CRITERIA }),
		)
	})
})
