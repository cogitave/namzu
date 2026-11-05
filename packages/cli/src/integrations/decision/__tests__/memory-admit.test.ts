import type { PromoteMemory } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import {
	MEMORY_ADMIT_STATE_CHARS,
	gateMemoryPromotion,
	holdsClaims,
	memoryAdmitQuestion,
} from '../memory-admit.js'
import { type DecisionPoints, createDecisionPoints } from '../points.js'

type Candidate = Parameters<PromoteMemory>[0]

function candidate(extra: Partial<Candidate> = {}): Candidate {
	return {
		sessionId: 's' as never,
		turnId: 't' as never,
		task: 'Fix the login redirect',
		decisions: ['Keep the session cookie httpOnly'],
		discoveries: ['The redirect reads next= from the query string'],
		userRequirements: [],
		failures: [],
		environment: [],
		files: ['/secret/path/auth.ts'],
		evicted: {},
		...extra,
	}
}

function pointsAnswering(
	p: number | undefined,
	mode: 'off' | 'shadow' | 'on',
): {
	points: DecisionPoints
	asked: string[]
} {
	const asked: string[] = []
	const points = createDecisionPoints({
		model:
			p === undefined
				? ({
						yesno: async () => {
							throw new Error('503')
						},
					} as never)
				: ({
						yesno: async (state: string) => {
							asked.push(state)
							return { p }
						},
					} as never),
		modes: { 'memory-admit': mode },
		log: () => {},
	})
	return { points, asked }
}

describe('the memory-admit point', () => {
	it('asks the model about the claims and the task, never the file paths', () => {
		const q = memoryAdmitQuestion(candidate())
		expect(q.point).toBe('memory-admit')
		expect(q.rule).toBe(true)
		expect(q.state).toContain('Fix the login redirect')
		expect(q.state).toContain('Keep the session cookie httpOnly')
		expect(q.state).not.toContain('/secret/path')
	})

	it('cuts a long set of claims and drops control characters', () => {
		const q = memoryAdmitQuestion(
			candidate({ discoveries: [`${'y'.repeat(5000)}\u0007\u001b[31m`] }),
		)
		expect([...q.state].length).toBeLessThanOrEqual(MEMORY_ADMIT_STATE_CHARS)
		expect(q.state.includes('\u0007')).toBe(false)
		expect(q.state.includes('\u001b')).toBe(false)
	})

	it('sees no claim in a candidate with only empty entries', () => {
		expect(holdsClaims(candidate({ decisions: [' '], discoveries: [] }))).toBe(false)
		expect(holdsClaims(candidate())).toBe(true)
	})
})

describe('gating the memory promoter', () => {
	it('off: the promoter runs and the model is never asked', async () => {
		const promote = vi.fn()
		const { points, asked } = pointsAnswering(0.01, 'off')
		await gateMemoryPromotion(promote, points)(candidate())
		expect(promote).toHaveBeenCalledTimes(1)
		expect(asked).toEqual([])
	})

	it('shadow: the model is asked and the promoter runs whatever it says', async () => {
		const promote = vi.fn()
		const { points, asked } = pointsAnswering(0.01, 'shadow')
		await gateMemoryPromotion(promote, points)(candidate())
		expect(asked).toHaveLength(1)
		expect(promote).toHaveBeenCalledTimes(1)
	})

	it('on: a confident no writes nothing', async () => {
		const promote = vi.fn()
		const { points, asked } = pointsAnswering(0.05, 'on')
		await gateMemoryPromotion(promote, points)(candidate())
		expect(asked).toHaveLength(1)
		expect(promote).not.toHaveBeenCalled()
	})

	it.each([0.9, 0.5])('on: an answer of %s writes as before', async (p) => {
		const promote = vi.fn()
		const { points } = pointsAnswering(p, 'on')
		await gateMemoryPromotion(promote, points)(candidate())
		expect(promote).toHaveBeenCalledTimes(1)
	})

	it('on: a model that fails writes as before', async () => {
		const promote = vi.fn()
		const { points } = pointsAnswering(undefined, 'on')
		await gateMemoryPromotion(promote, points)(candidate())
		expect(promote).toHaveBeenCalledTimes(1)
	})

	it('asks nothing for a turn that learned nothing, and still hands it to the promoter', async () => {
		const promote = vi.fn()
		const { points, asked } = pointsAnswering(0.01, 'on')
		await gateMemoryPromotion(promote, points)(candidate({ decisions: [], discoveries: [] }))
		expect(asked).toEqual([])
		expect(promote).toHaveBeenCalledTimes(1)
	})
})
