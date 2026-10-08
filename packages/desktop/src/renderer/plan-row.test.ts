import type { AcpTask } from '@namzu/sdk'
import { expect, it } from 'vitest'
import { applyEvent, emptyThread } from '../shared/projection.js'
import {
	isTaskEntry,
	isTaskTool,
	latestPlanTurn,
	planLabel,
	planSummary,
	planVisibleTasks,
} from './plan-row.js'

const task = (taskId: string, status: AcpTask['status'], subject = taskId): AcpTask => ({
	taskId,
	subject,
	status,
	blockedBy: [],
})

it('knows the plan tools by any spelling and nothing else', () => {
	for (const name of [
		'task_create',
		'TaskUpdate',
		'task_list',
		'TodoWrite',
		'update_plan',
		'srv.task_create',
	])
		expect(isTaskTool(name)).toBe(true)
	for (const name of ['bash', 'update_plan_step', 'Task', undefined, 'task_stop'])
		expect(isTaskTool(name)).toBe(false)
})

it('reads the live plan as a count with the task in progress, and settles it when the turn ends', () => {
	const tasks = [
		task('a', 'completed'),
		task('b', 'in_progress', 'Write the tests'),
		task('c', 'pending'),
	]
	const summary = planSummary(tasks)
	expect(planLabel(summary, true)).toEqual({
		text: 'Plan · 1/3',
		current: 'Write the tests',
		tone: 'live',
	})
	expect(planLabel(summary, false)).toEqual({ text: 'Plan · 1/3', tone: 'normal' })
	expect(planLabel(planSummary([task('a', 'completed')]), false)).toEqual({
		text: 'Plan · 1/1 done',
		tone: 'muted',
	})
})

it('does not call a plan with a failed task finished', () => {
	const summary = planSummary([task('a', 'completed'), task('b', 'failed')])
	expect(summary.finished).toBe(false)
	expect(summary.failed).toBe(1)
})

it('shows six tasks and counts the rest', () => {
	const tasks = Array.from({ length: 9 }, (_, index) => task(`t${index}`, 'pending'))
	const { shown, more } = planVisibleTasks(tasks)
	expect(shown).toHaveLength(6)
	expect(more).toBe(3)
})

it('names the last turn that touched the plan', () => {
	let thread = emptyThread()
	for (const [turn, name] of [
		[1, 'task_create'],
		[2, 'bash'],
	] as const) {
		thread = applyEvent(thread, { kind: 'prompt', sessionId: 's', prompt: `p${turn}` })
		thread = applyEvent(thread, {
			kind: 'update',
			sessionId: 's',
			update: {
				kind: 'tool_call',
				toolCallId: `c${turn}`,
				title: name,
				status: 'completed',
				view: { kind: 'generic', label: name },
			},
		} as never)
	}
	expect(latestPlanTurn(thread)).toBe(1)
	expect(latestPlanTurn(emptyThread())).toBeUndefined()
})

it('folds an engine list tool only once there is a plan to fold it into', () => {
	let thread = applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'p' })
	thread = applyEvent(thread, {
		kind: 'update',
		sessionId: 's',
		update: {
			kind: 'tool_call',
			toolCallId: 'c',
			title: 'claude:TodoWrite',
			status: 'completed',
			view: { kind: 'generic', label: 'Updated tasks' },
		},
	} as never)
	const entry = thread.timeline.find((candidate) => candidate.kind === 'tool')
	if (!entry) throw new Error('no tool entry')
	// Engines emit no task events, so hiding the tool would hide all of their progress.
	expect(isTaskEntry(thread, entry)).toBe(false)
	expect(latestPlanTurn(thread)).toBeUndefined()
	expect(isTaskEntry({ ...thread, tasks: [task('a', 'pending')] }, entry)).toBe(true)
})
