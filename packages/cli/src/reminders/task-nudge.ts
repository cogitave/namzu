import type { Message, Task } from '@namzu/sdk'

import { frameReminder, isOperatorTurn, reminderKindOf } from './frame.js'

/**
 * The task-list nudge: after 10 model
 * turns without a task tool, and no more than once per 10 model turns, the
 * model is reminded the list exists and shown its current contents. It speaks
 * only while the current request has run three or more steps (model turns
 * that called a tool), because a list is for work of that size.
 *
 * The nudge is a hidden reminder: the person's transcript, exports and
 * history views never show it.
 *
 * A "model turn" is one assistant message. The count runs over the
 * conversation itself, so it survives a resume and restarts when compaction
 * drops the history it was counting.
 */
export const TASK_NUDGE_AFTER_TURNS = 10
export const TASK_NUDGE_EVERY_TURNS = 10
export const TASK_NUDGE_MIN_STEPS = 3

const TASK_TOOLS = new Set(['task_create', 'task_update'])

export function taskNudgeCounts(messages: readonly Message[]): {
	readonly sinceTaskTool: number
	readonly sinceNudge: number
} {
	let sinceTaskTool = 0
	let sinceNudge = 0
	let sawTool = false
	let sawNudge = false
	for (let i = messages.length - 1; i >= 0 && !(sawTool && sawNudge); i--) {
		const message = messages[i] as Message
		if (message.role === 'assistant') {
			if (!sawTool && message.toolCalls?.some((call) => TASK_TOOLS.has(call.function.name))) {
				sawTool = true
			}
			if (!sawTool) sinceTaskTool++
			if (!sawNudge) sinceNudge++
		} else if (!sawNudge && reminderKindOf(message) === 'task-nudge') {
			sawNudge = true
		}
	}
	return { sinceTaskTool, sinceNudge }
}

/** Model turns that called a tool since the person's latest message. */
export function stepsThisRequest(messages: readonly Message[]): number {
	let steps = 0
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Message
		if (isOperatorTurn(message)) break
		if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) steps++
	}
	return steps
}

function listText(tasks: readonly Pick<Task, 'id' | 'status' | 'subject'>[]): string {
	return tasks.map((task) => `#${task.id}. [${task.status}] ${task.subject}`).join('\n')
}

export function taskNudge(
	messages: readonly Message[],
	tasks: readonly Pick<Task, 'id' | 'status' | 'subject'>[],
): string[] {
	if (messages.length === 0) return []
	const { sinceTaskTool, sinceNudge } = taskNudgeCounts(messages)
	if (sinceTaskTool < TASK_NUDGE_AFTER_TURNS || sinceNudge < TASK_NUDGE_EVERY_TURNS) return []
	if (stepsThisRequest(messages) < TASK_NUDGE_MIN_STEPS) return []
	const head =
		'This work has run several steps without the task tools. If it has three or more steps worth tracking, add them with task_create and keep their status current with task_update (in_progress when you start one, completed when it is done); if the list has gone stale, tidy it. Otherwise ignore this note. It is for you alone, so keep it out of your replies to the user.'
	return [
		frameReminder(
			'task-nudge',
			tasks.length > 0 ? `${head}\n\nThe task list now:\n${listText(tasks)}` : head,
		),
	]
}
