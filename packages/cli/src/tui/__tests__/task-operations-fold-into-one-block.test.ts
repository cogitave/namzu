/**
 * Consecutive task operations become one transcript block, in words.
 *
 * Pure: the grouping and the header text, without rendering. The rendered
 * block is pinned in `task-list-reaches-app.test.tsx`.
 */

import { describe, expect, it } from 'vitest'

import type { ChecklistItem } from '../Checklist.js'
import {
	type TaskBlockInput,
	applyTaskOperation,
	isTaskTool,
	removeTask,
	taskBlockHeader,
	taskOperationFor,
	upsertTask,
} from '../task-activity.js'
import type { TranscriptMessage } from '../types.js'

const item = (id: string, subject: string, status: ChecklistItem['status']): ChecklistItem => ({
	id,
	subject,
	status,
})

let ids = 0
const input = (
	over: Partial<TaskBlockInput> & Pick<TaskBlockInput, 'checklist'>,
): TaskBlockInput => ({
	key: 'turn-1',
	id: `row-${++ids}`,
	operation: null,
	settled: 0,
	...over,
})

describe('what one task event did', () => {
	const parser = item('a', 'Ayrıştırıcıyı yaz', 'pending')
	it('reads the change from the previous state', () => {
		expect(taskOperationFor(undefined, parser)).toEqual({
			kind: 'added',
			subject: 'Ayrıştırıcıyı yaz',
		})
		expect(taskOperationFor(parser, { ...parser, status: 'in_progress' })?.kind).toBe('started')
		expect(taskOperationFor(parser, { ...parser, status: 'completed' })?.kind).toBe('completed')
		expect(taskOperationFor(parser, { ...parser, status: 'failed' })?.kind).toBe('failed')
		expect(taskOperationFor({ ...parser, status: 'completed' }, parser)?.kind).toBe('reopened')
		expect(taskOperationFor(parser, { ...parser, subject: 'Yeni ad' })?.kind).toBe('renamed')
		expect(
			taskOperationFor(parser, parser),
			'an owner change is not news to the operator',
		).toBeNull()
	})

	it('upserts by id, keeping order', () => {
		const list = upsertTask(upsertTask([], parser), item('b', 'Test yaz', 'pending'))
		expect(upsertTask(list, { ...parser, status: 'completed' }).map((t) => t.status)).toEqual([
			'completed',
			'pending',
		])
	})

	it('drops a removed task and names the removal, and ignores one it never drew', () => {
		const list = upsertTask(upsertTask([], parser), item('b', 'Test yaz', 'pending'))
		const after = removeTask(list, 'b', 'Test yaz')
		expect(after.tasks.map((t) => t.id)).toEqual(['a'])
		expect(after.operation).toEqual({ kind: 'removed', subject: 'Test yaz' })
		expect(taskBlockHeader([after.operation!], after.tasks)).toBe('Removed task · Test yaz')
		expect(removeTask(list, 'zz', 'unknown')).toEqual({ tasks: list, operation: null })
	})

	it('owns exactly the three planning tools', () => {
		expect(['task_create', 'task_update', 'task_list'].every(isTaskTool)).toBe(true)
		expect(isTaskTool('agent_task_list')).toBe(false)
	})
})

describe('the block header', () => {
	const two = [item('a', 'One', 'pending'), item('b', 'Two', 'pending')]
	it('names a single operation with its subject', () => {
		expect(taskBlockHeader([{ kind: 'added', subject: 'One' }], two)).toBe('Added task · One')
		expect(taskBlockHeader([{ kind: 'started', subject: 'One' }], two)).toBe('Started · One')
		expect(taskBlockHeader([{ kind: 'completed', subject: 'One' }], two)).toBe('Completed · One')
	})

	it('counts repeated operations with a correct plural', () => {
		const added = [
			{ kind: 'added', subject: 'One' },
			{ kind: 'added', subject: 'Two' },
		] as const
		expect(taskBlockHeader(added, two)).toBe('Added 2 tasks')
	})

	it('falls back to the progress count for a mix, or for a listing', () => {
		const mix = [
			{ kind: 'completed', subject: 'One' },
			{ kind: 'started', subject: 'Two' },
		] as const
		const after = [item('a', 'One', 'completed'), item('b', 'Two', 'in_progress')]
		expect(taskBlockHeader(mix, after)).toBe('Tasks · 1/2 done')
		expect(taskBlockHeader([], after)).toBe('Tasks · 1/2 done')
		expect(taskBlockHeader([], [])).toBe('No tasks yet')
		expect(taskBlockHeader([], [item('a', 'One', 'completed')])).toBe('Tasks · 1/1 done')
	})
})

describe('folding into one block', () => {
	it('grows the open block while it is the last row of the same turn', () => {
		const a = item('a', 'One', 'pending')
		const b = item('b', 'Two', 'pending')
		let rows: readonly TranscriptMessage[] = []
		rows = applyTaskOperation(
			rows,
			input({ operation: { kind: 'added', subject: 'One' }, checklist: [a] }),
		)
		rows = applyTaskOperation(
			rows,
			input({ operation: { kind: 'added', subject: 'Two' }, checklist: [a, b] }),
		)
		rows = applyTaskOperation(rows, input({ checklist: [a, b] }))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.content).toBe('Added 2 tasks')
		expect(rows[0]?.checklist).toEqual([a, b])
	})

	it('opens a new block after anything else is written, and for another turn', () => {
		const a = item('a', 'One', 'pending')
		let rows: readonly TranscriptMessage[] = applyTaskOperation(
			[],
			input({ operation: { kind: 'added', subject: 'One' }, checklist: [a] }),
		)
		rows = [...rows, { id: 'reply', role: 'assistant', content: 'Starting.' }]
		const started = { ...a, status: 'in_progress' as const }
		rows = applyTaskOperation(
			rows,
			input({ operation: { kind: 'started', subject: 'One' }, checklist: [started] }),
		)
		expect(rows.map((r) => r.content)).toEqual(['Added task · One', 'Starting.', 'Started · One'])

		rows = applyTaskOperation(
			rows,
			input({ key: 'turn-2', operation: { kind: 'completed', subject: 'One' }, checklist: [a] }),
		)
		expect(rows).toHaveLength(4)
	})

	it('never extends a block already printed into scrollback', () => {
		const a = item('a', 'One', 'pending')
		let rows = applyTaskOperation(
			[],
			input({ operation: { kind: 'added', subject: 'One' }, checklist: [a] }),
		)
		// One finalized row is in native scrollback: the block itself.
		rows = applyTaskOperation(
			rows,
			input({ operation: { kind: 'started', subject: 'One' }, checklist: [a], settled: 1 }),
		)
		expect(rows).toHaveLength(2)
	})

	it('writes nothing for a listing with no plan and no open block', () => {
		expect(applyTaskOperation([], input({ checklist: [] }))).toEqual([])
	})
})
