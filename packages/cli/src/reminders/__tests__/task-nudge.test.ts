import {
	type Message,
	createAssistantMessage,
	createRuntimeContextMessage,
	createToolMessage,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	TASK_NUDGE_AFTER_TURNS,
	TASK_NUDGE_EVERY_TURNS,
	TASK_NUDGE_MIN_STEPS,
	stepsThisRequest,
	taskNudge,
} from '../task-nudge.js'

/**
 * The task-list nudge: after 10 model turns without a task tool, at most once
 * per 10 model turns, with the list as it stands. A model turn is one
 * assistant message.
 */

const call = (name: string) => [
	{
		id: `c-${name}`,
		type: 'function' as const,
		function: { name, arguments: '{}' },
	},
]
const turn = (name?: string): Message[] => [
	createAssistantMessage(null, name ? call(name) : undefined),
	...(name ? [createToolMessage('ok', `c-${name}`)] : []),
]
const turns = (n: number, name = 'read'): Message[] =>
	Array.from({ length: n }, () => turn(name)).flat()
const tasks = [
	{
		id: 't1' as never,
		status: 'in_progress' as const,
		subject: 'Wire the dialog',
	},
	{ id: 't2' as never, status: 'pending' as const, subject: 'Write the tests' },
]

describe('the task-list nudge', () => {
	it('waits for 10 turns without a task tool', () => {
		const history = [createUserMessage('go'), ...turns(TASK_NUDGE_AFTER_TURNS - 1)]
		expect(taskNudge(history, tasks)).toEqual([])
		const [nudge] = taskNudge([...history, ...turn('read')], tasks)
		expect(nudge).toContain('kind="task-nudge"')
		expect(nudge).toContain('task_create')
		expect(nudge).toContain('#t1. [in_progress] Wire the dialog')
		expect(nudge).toContain('#t2. [pending] Write the tests')
	})

	it('is reset by task_create and by task_update', () => {
		for (const name of ['task_create', 'task_update']) {
			const history = [createUserMessage('go'), ...turns(12), ...turn(name), ...turns(9)]
			expect(taskNudge(history, tasks), name).toEqual([])
			expect(taskNudge([...history, ...turn('read')], tasks), name).toHaveLength(1)
		}
	})

	it('speaks at most once per 10 turns', () => {
		const history: Message[] = [createUserMessage('go'), ...turns(10)]
		const [first] = taskNudge(history, tasks)
		history.push(createRuntimeContextMessage(first as string, 'reminder'), ...turns(9))
		expect(taskNudge(history, tasks)).toEqual([])
		history.push(...turn('read'))
		expect(taskNudge(history, tasks)).toHaveLength(1)
	})

	it('still nudges with an empty list, and says nothing without a conversation', () => {
		const [nudge] = taskNudge([createUserMessage('go'), ...turns(10)], [])
		expect(nudge).toContain('task_create')
		expect(nudge).not.toContain('The task list now')
		expect(taskNudge([], tasks)).toEqual([])
		expect(TASK_NUDGE_EVERY_TURNS).toBe(10)
	})

	it('stays quiet until the request has run three tool steps', () => {
		// Ten model turns without a task tool, but the person's latest message
		// came after nearly all of them.
		const old = [createUserMessage('earlier'), ...turns(12)]
		const short = [
			...old,
			createUserMessage('and one more thing'),
			...turns(TASK_NUDGE_MIN_STEPS - 1),
		]
		expect(stepsThisRequest(short)).toBe(TASK_NUDGE_MIN_STEPS - 1)
		expect(taskNudge(short, tasks)).toEqual([])
		const long = [...short, ...turn('read')]
		expect(stepsThisRequest(long)).toBe(TASK_NUDGE_MIN_STEPS)
		expect(taskNudge(long, tasks)).toHaveLength(1)
	})

	it('counts tool steps, not plain replies', () => {
		const history = [
			createUserMessage('go'),
			...turns(9),
			createAssistantMessage('thinking out loud'),
			...turn('read'),
		]
		expect(stepsThisRequest(history)).toBe(10)
	})

	it('tells the model to keep the note to itself', () => {
		const [nudge] = taskNudge([createUserMessage('go'), ...turns(10)], tasks)
		expect(nudge).toContain('three or more steps')
		expect(nudge).toContain('keep it out of your replies to the user')
	})
})
