import type { DecisionModel } from '@namzu/decision'
import { describe, expect, it } from 'vitest'

import { createDecisionPoints } from '../points.js'
import { SKILL_WORTHY_REQUEST_CHARS, skillProposalStands, skillWorthyQuestion } from '../skill.js'

const input = {
	request: 'Prepare the release branch and tag it',
	tools: ['bash', 'edit', 'bash'],
	steps: 7,
}

function pointsAnswering(p: number | undefined, mode: 'off' | 'shadow' | 'on') {
	const asked: string[] = []
	const model = {
		yesno: async (state: string) => {
			if (p === undefined) throw new Error('503')
			asked.push(state)
			return { p }
		},
	} as unknown as DecisionModel
	return {
		asked,
		points: createDecisionPoints({ model, modes: { skill: mode }, log: () => {} }),
	}
}

describe('the skill question', () => {
	it('sends the request and the distinct tool names, and nothing else', () => {
		const q = skillWorthyQuestion(input)
		expect(q.point).toBe('skill')
		expect(q.state).toContain('Prepare the release branch')
		expect(q.state).toContain('bash, edit')
		expect(q.state.match(/bash/gu)).toHaveLength(1)
		expect(q.rule).toBe(true)
	})

	it('cuts a long request and drops control characters', () => {
		const q = skillWorthyQuestion({ ...input, request: `${'z'.repeat(5000)}\u0007\u001b[1m` })
		expect(q.state.includes('\u0007')).toBe(false)
		expect(q.state.includes('\u001b')).toBe(false)
		expect(q.state.length).toBeLessThan(SKILL_WORTHY_REQUEST_CHARS + 200)
	})
})

describe('a skill proposal and the model', () => {
	it('off: it stands and the model is never asked', async () => {
		const { points, asked } = pointsAnswering(0.01, 'off')
		expect(await skillProposalStands(points, input)).toBe(true)
		expect(asked).toEqual([])
	})

	it('shadow: the model is asked and the proposal still stands', async () => {
		const { points, asked } = pointsAnswering(0.01, 'shadow')
		expect(await skillProposalStands(points, input)).toBe(true)
		expect(asked).toHaveLength(1)
	})

	it('on: a confident no withdraws it; yes, unsure and failure keep it', async () => {
		expect(await skillProposalStands(pointsAnswering(0.05, 'on').points, input)).toBe(false)
		expect(await skillProposalStands(pointsAnswering(0.9, 'on').points, input)).toBe(true)
		expect(await skillProposalStands(pointsAnswering(0.5, 'on').points, input)).toBe(true)
		expect(await skillProposalStands(pointsAnswering(undefined, 'on').points, input)).toBe(true)
	})
})
