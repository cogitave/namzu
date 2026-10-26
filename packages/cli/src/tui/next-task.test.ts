import { describe, expect, it } from 'vitest'

import type { ChecklistItem } from './Checklist.js'
import { nextTask, nextTaskLine } from './next-task.js'

const task = (
	id: string,
	status: ChecklistItem['status'],
	blockedBy?: string[],
): ChecklistItem => ({
	id,
	subject: `task ${id}`,
	status,
	...(blockedBy ? { blockedBy } : {}),
})

describe('nextTask', () => {
	it('is the first pending task whose blockers are finished', () => {
		const tasks = [
			task('1', 'completed'),
			task('2', 'in_progress'),
			task('3', 'pending', ['2']),
			task('4', 'pending', ['1']),
		]
		expect(nextTask(tasks)?.id).toBe('4')
	})

	it('falls back to the first pending task when every one is blocked', () => {
		expect(
			nextTask([task('1', 'in_progress'), task('2', 'pending', ['1']), task('3', 'pending', ['1'])])
				?.id,
		).toBe('2')
	})

	it('treats a blocker missing from the list as finished', () => {
		expect(nextTask([task('2', 'pending', ['gone'])])?.id).toBe('2')
	})

	it('is undefined when nothing is pending', () => {
		expect(nextTask([task('1', 'completed'), task('2', 'in_progress')])).toBeUndefined()
		expect(nextTask([])).toBeUndefined()
	})

	it('collapses whitespace in the line', () => {
		expect(nextTaskLine({ id: '1', subject: '  fix\n the   bug ', status: 'pending' })).toBe(
			'Next: fix the bug',
		)
	})
})
