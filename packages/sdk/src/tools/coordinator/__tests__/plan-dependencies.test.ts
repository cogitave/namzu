import { describe, expect, it } from 'vitest'

import { resolvePlanDependencies } from '../plan-dependencies.js'

/**
 * The model is shown `depends_on` on every plan step and told it means
 * "Step descriptions this depends on". `approve_plan` then passed
 * `dependsOn: []` for every step, so the ordering it declared was discarded
 * at the only place it entered the system.
 *
 * The cost is not scheduling — the dependency gate in `PlanManager` has no
 * callers — it is the approval. `dependsOn` is serialized into the
 * `plan_approval` payload a human reads before saying yes, so the reviewer
 * saw a plan whose steps all looked independent however carefully the model
 * had ordered them.
 */

const id = (index: number) => `step_${index + 1}`

describe('what the model described becomes what the plan holds', () => {
	it('resolves a description to the step that carries it', () => {
		const result = resolvePlanDependencies(
			[
				{ description: 'Read the config' },
				{ description: 'Write the report', depends_on: ['Read the config'] },
			],
			id,
		)

		expect(result).toEqual({ ok: true, dependsOn: [[], ['step_1']] })
	})

	it('resolves several dependencies on one step', () => {
		const result = resolvePlanDependencies(
			[
				{ description: 'Read the config' },
				{ description: 'Read the code' },
				{ description: 'Write the report', depends_on: ['Read the config', 'Read the code'] },
			],
			id,
		)

		expect(result.ok && result.dependsOn[2]).toEqual(['step_1', 'step_2'])
	})

	it('resolves a forward dependency, since order of declaration is not order of execution', () => {
		const result = resolvePlanDependencies(
			[
				{ description: 'Write the report', depends_on: ['Read the config'] },
				{ description: 'Read the config' },
			],
			id,
		)

		expect(result.ok && result.dependsOn[0]).toEqual(['step_2'])
	})

	it('leaves a step with no dependencies empty', () => {
		const result = resolvePlanDependencies([{ description: 'Read the config' }], id)

		expect(result).toEqual({ ok: true, dependsOn: [[]] })
	})

	it('forgives whitespace and casing a model did not keep identical', () => {
		const result = resolvePlanDependencies(
			[
				{ description: 'Read  the config' },
				{ description: 'Write', depends_on: ['read the   CONFIG '] },
			],
			id,
		)

		// Rejecting this would teach the model nothing, for a plan that was
		// right.
		expect(result.ok && result.dependsOn[1]).toEqual(['step_1'])
	})

	it('collapses the same dependency named twice', () => {
		const result = resolvePlanDependencies(
			[{ description: 'Read' }, { description: 'Write', depends_on: ['Read', 'Read'] }],
			id,
		)

		expect(result.ok && result.dependsOn[1]).toEqual(['step_1'])
	})
})

describe('a dependency that cannot mean anything is refused, not dropped', () => {
	it('refuses a dependency naming no step', () => {
		const result = resolvePlanDependencies(
			[{ description: 'Write', depends_on: ['Read the config'] }],
			id,
		)

		expect(result.ok).toBe(false)
		// The model has to be able to act on it, so the offending text is named.
		expect(!result.ok && result.error).toContain('Read the config')
	})

	it('refuses a dependency two steps could answer', () => {
		const result = resolvePlanDependencies(
			[
				{ description: 'Review' },
				{ description: 'Review' },
				{ description: 'Report', depends_on: ['Review'] },
			],
			id,
		)

		// Picking either is a coin flip whose result a human then approves as
		// if it were the model's intent.
		expect(result.ok).toBe(false)
		expect(!result.ok && result.error).toContain('2 steps share that description')
	})

	it('refuses a step that depends on itself', () => {
		const result = resolvePlanDependencies([{ description: 'Loop', depends_on: ['Loop'] }], id)

		expect(result.ok).toBe(false)
		expect(!result.ok && result.error).toContain('depends on itself')
	})

	it('refuses a two-step cycle', () => {
		const result = resolvePlanDependencies(
			[
				{ description: 'A', depends_on: ['B'] },
				{ description: 'B', depends_on: ['A'] },
			],
			id,
		)

		expect(result.ok).toBe(false)
		expect(!result.ok && result.error).toContain('loop')
	})

	it('refuses a cycle several steps long', () => {
		const result = resolvePlanDependencies(
			[
				{ description: 'A', depends_on: ['C'] },
				{ description: 'B', depends_on: ['A'] },
				{ description: 'C', depends_on: ['B'] },
			],
			id,
		)

		// This is the failure worth catching hardest: no step in a loop can
		// start, so the plan does not error — it simply stops.
		expect(result.ok).toBe(false)
		expect(!result.ok && result.error).toContain('loop')
	})

	it('names every step in the loop so it can be broken', () => {
		const result = resolvePlanDependencies(
			[
				{ description: 'Alpha', depends_on: ['Gamma'] },
				{ description: 'Beta' },
				{ description: 'Gamma', depends_on: ['Alpha'] },
			],
			id,
		)

		expect(result.ok).toBe(false)
		if (result.ok) return
		expect(result.error).toContain('Alpha')
		expect(result.error).toContain('Gamma')
		// Beta is not in the loop and must not be blamed for it.
		expect(result.error).not.toContain('Beta')
	})

	it('accepts a diamond, which is not a cycle', () => {
		const result = resolvePlanDependencies(
			[
				{ description: 'Start' },
				{ description: 'Left', depends_on: ['Start'] },
				{ description: 'Right', depends_on: ['Start'] },
				{ description: 'Join', depends_on: ['Left', 'Right'] },
			],
			id,
		)

		// Two paths reaching one step is an ordinary plan shape, and a naive
		// visited-set cycle check calls it a loop.
		expect(result.ok).toBe(true)
		expect(result.ok && result.dependsOn[3]).toEqual(['step_2', 'step_3'])
	})
})
