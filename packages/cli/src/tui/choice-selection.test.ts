import { describe, expect, it } from 'vitest'

import {
	choicePickerWindowSize,
	filterChoiceOptions,
	moveChoiceSelection,
} from './choice-selection.js'

describe('controlled choice selection', () => {
	it('retains original option identity while matching labels, descriptions and searchable values', () => {
		const options = [
			{
				label: 'fix memory',
				description: 'release branch',
				searchText: 'a73f91',
				value: 'branch-A',
			},
			{
				label: 'fix memory',
				description: 'feature branch',
				searchText: 'b873a2',
				value: 'branch-B',
			},
		]
		expect(filterChoiceOptions(options, '')).toBe(options)
		expect(filterChoiceOptions(options, 'memory A73')).toEqual([options[0]])
		expect(filterChoiceOptions(options, 'MEMORY feature')[0]).toBe(options[1])
		expect(filterChoiceOptions(options, 'missing')).toEqual([])
	})

	it('skips disabled options across boundaries and pages without selecting a different value', () => {
		const options = Array.from({ length: 12 }, (_, index) => ({
			label: `option ${index}`,
			description: '',
			disabledReason: [0, 2, 7, 11].includes(index) ? 'Not configured' : undefined,
		}))
		expect(moveChoiceSelection(options, 1, 'next')).toBe(3)
		expect(moveChoiceSelection(options, 3, 'previous')).toBe(1)
		expect(moveChoiceSelection(options, 1, 'next-page', 6)).toBe(8)
		expect(moveChoiceSelection(options, 8, 'previous-page', 6)).toBe(1)
		expect(moveChoiceSelection(options, 8, 'first')).toBe(1)
		expect(moveChoiceSelection(options, 8, 'last')).toBe(10)
		expect(moveChoiceSelection(options, 10, 'next')).toBe(10)
		expect(moveChoiceSelection(options.slice(0, 1), 0, 'first')).toBe(-1)
		expect(moveChoiceSelection([], 0, 'next')).toBe(-1)
	})

	it('budgets two-row narrow options and all fixed furniture inside the terminal', () => {
		for (const columns of [40, 60, 100]) {
			for (const rows of [14, 18, 30]) {
				const count = choicePickerWindowSize({
					columns,
					rows,
					searchable: true,
					notice: true,
					selectedDescription: true,
				})
				expect(count).toBeGreaterThanOrEqual(1)
				expect(count * (columns < 70 ? 2 : 1) + 7).toBeLessThanOrEqual(rows - 4)
			}
		}
	})
})
