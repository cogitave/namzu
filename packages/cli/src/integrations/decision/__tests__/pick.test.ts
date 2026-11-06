import type { DecisionModel } from '@namzu/decision'
import { describe, expect, it, vi } from 'vitest'

import { createPickAdvisor } from '../pick.js'
import { type DecisionLogEntry, createDecisionPoints } from '../points.js'

const candidates = [
	{ ref: 'e1', description: 'Button "Save"' },
	{ ref: 'e2', description: 'Button "Cancel"' },
	{ ref: 'e3', description: 'Edit "Name"' },
]

function pointsWith(
	mode: 'off' | 'shadow' | 'on',
	answer: (options: readonly string[]) => Record<string, number>,
) {
	const entries: DecisionLogEntry[] = []
	const choice = vi.fn(
		async (_state: string, _instructions: string, options: readonly string[]) => ({
			option: options[0],
			probabilities: answer(options),
		}),
	)
	const points = createDecisionPoints({
		model: { choice } as unknown as DecisionModel,
		modes: { pick: mode },
		log: (e) => entries.push(e),
	})
	return { points, choice, entries }
}

describe('the pick advisor', () => {
	it('does not exist while the point is off, so the tool is the tool without one', () => {
		const { points } = pointsWith('off', () => ({}))
		expect(createPickAdvisor(points)).toBeUndefined()
	})

	it('only watches in shadow mode and acts in on mode', () => {
		expect(createPickAdvisor(pointsWith('shadow', () => ({})).points)?.acts).toBe(false)
		expect(createPickAdvisor(pointsWith('on', () => ({})).points)?.acts).toBe(true)
	})

	it('puts the controls to the model as options and maps the answer back to refs', async () => {
		const { points, choice } = pointsWith('on', (options) => ({
			[options[0] as string]: 0.05,
			[options[1] as string]: 0.9,
			[options[2] as string]: 0.05,
		}))
		const advice = await createPickAdvisor(points)?.pick({
			intent: 'abandon this',
			candidates,
		})
		expect(advice?.ranked[0]).toEqual({ ref: 'e2', confidence: 0.9 })
		const [state, , options] = choice.mock.calls[0] ?? []
		expect(state).toBe('Described action: abandon this')
		expect(options).toEqual(['e1 Button "Save"', 'e2 Button "Cancel"', 'e3 Edit "Name"'])
	})

	it('compares with the control the model chose, in shadow mode, and returns nothing', async () => {
		const { points, entries } = pointsWith('shadow', (options) => ({
			[options[0] as string]: 0.9,
			[options[1] as string]: 0.05,
			[options[2] as string]: 0.05,
		}))
		const advice = await createPickAdvisor(points)?.pick({
			intent: 'save',
			candidates,
			chosen: 'e1',
		})
		expect(advice).toBeUndefined()
		expect(entries[0]).toMatchObject({
			point: 'pick',
			mode: 'shadow',
			p: 0.9,
			agreed: true,
		})
	})

	it('does not ask about fewer than two controls or about two that read alike', async () => {
		const { points, choice } = pointsWith('on', () => ({}))
		const advisor = createPickAdvisor(points)
		expect(await advisor?.pick({ intent: 'x', candidates: candidates.slice(0, 1) })).toBeUndefined()
		expect(
			await advisor?.pick({
				intent: 'x',
				candidates: [candidates[0], candidates[0]] as typeof candidates,
			}),
		).toBeUndefined()
		expect(choice).not.toHaveBeenCalled()
	})

	it('removes control characters from what leaves the machine', async () => {
		const { points, choice } = pointsWith('on', (options) =>
			Object.fromEntries(options.map((option) => [option, 0.5])),
		)
		await createPickAdvisor(points)?.pick({
			intent: 'save\u0007 it',
			candidates: [
				{ ref: 'e1', description: 'Button "Sa\u001bve"' },
				{ ref: 'e2', description: 'Button "Cancel"' },
			],
		})
		const [state, , options] = choice.mock.calls[0] ?? []
		expect(state).toBe('Described action: save it')
		expect(options).toEqual(['e1 Button "Save"', 'e2 Button "Cancel"'])
	})
})
