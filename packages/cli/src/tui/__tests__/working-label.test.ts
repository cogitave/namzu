import { describe, expect, it } from 'vitest'

import type { ChecklistItem } from '../Checklist.js'
import { workingLabel } from '../working-label.js'

const item = (
	over: Partial<ChecklistItem> & Pick<ChecklistItem, 'id' | 'status'>,
): ChecklistItem => ({
	subject: `Step ${over.id}`,
	...over,
})

describe('the working row names the step in progress', () => {
	it('uses the present-continuous form the model gave', () => {
		const tasks = [
			item({ id: '1', status: 'completed' }),
			item({
				id: '2',
				status: 'in_progress',
				subject: 'Run the tests',
				activeForm: 'Running the tests',
			}),
			item({ id: '3', status: 'pending' }),
		]
		expect(workingLabel(tasks, 120)).toBe('Running the tests')
	})

	it('falls back to the subject, on one line', () => {
		const tasks = [item({ id: '1', status: 'in_progress', subject: '  Write\n the   parser ' })]
		expect(workingLabel(tasks, 120)).toBe('Write the parser')
	})

	it('has no label without a step in progress', () => {
		expect(workingLabel([], 120)).toBeUndefined()
		expect(
			workingLabel(
				[item({ id: '1', status: 'pending' }), item({ id: '2', status: 'failed' })],
				120,
			),
		).toBeUndefined()
	})

	it('is cut to fit beside the clock on a narrow terminal', () => {
		const long = 'Reading every file under the workspace and summarising what each one is for'
		const label = workingLabel(
			[item({ id: '1', status: 'in_progress', subject: long })],
			50,
		) as string
		expect(label.length).toBe(12)
		expect(label.endsWith('…')).toBe(true)
		expect(
			(workingLabel([item({ id: '1', status: 'in_progress', subject: long })], 200) as string)
				.length,
		).toBeLessThanOrEqual(60)
	})
})
