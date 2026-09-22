import type { ToolResult } from '../../types/tool/index.js'
import type { ToolCallView, ToolResultView } from '../../types/tool/presentation.js'

/**
 * How the task tools read to a person.
 *
 * The model-facing output of these tools names task ids, because the model
 * needs them to call `task_update`. None of that is for the operator: with no
 * opinion of its own a task call fell through to the generic presenter, which
 * printed the arguments (`{"id":"01a0…","status":"completed"}`) as the call
 * row and the model's receipt (`Task 01a0… updated — status: completed`) as
 * the result. So each tool says what happened in words — `Added task ·
 * Write the parser` — and a successful receipt adds nothing beneath it.
 *
 * Deliberately no ids, no owner and no JSON anywhere in these views. A host
 * that wants the ids still has the tool result and its `data`.
 */

const MAX_SUBJECT = 100

function oneLine(value: string): string {
	const flat = value.replace(/\s+/g, ' ').trim()
	return flat.length > MAX_SUBJECT ? `${flat.slice(0, MAX_SUBJECT - 1)}…` : flat
}

function activity(label: string): ToolCallView {
	return { kind: 'generic', presentation: 'activity', label }
}

/** A successful receipt: the call row already said it. */
const HIDDEN_RESULT: ToolResultView = { kind: 'generic', label: '', visibility: 'hidden' }

/** `N task` / `N tasks`. */
export function countTasks(count: number): string {
	return `${count} task${count === 1 ? '' : 's'}`
}

/** What a failed task call says, without the id the model passed. */
function failure(result: ToolResult, fallback: string): ToolResultView {
	const text = `${result.error ?? result.output ?? ''}`
	return {
		kind: 'generic',
		label: /not found/i.test(text) ? 'No task has that id' : fallback,
	}
}

export function presentTaskCreateCall(input: { readonly subject?: unknown }): ToolCallView {
	const subject = typeof input.subject === 'string' ? oneLine(input.subject) : ''
	return activity(subject ? `Add task · ${subject}` : 'Add task')
}

export function presentTaskCreateResult(_input: unknown, result: ToolResult): ToolResultView {
	if (!result.success) return failure(result, 'The task was not added')
	return HIDDEN_RESULT
}

/** The verb for a `task_update` call, from the status it asks for. */
export function taskUpdateVerb(status: unknown): string {
	switch (status) {
		case 'in_progress':
			return 'Start task'
		case 'completed':
			return 'Complete task'
		case 'deleted':
			return 'Remove task'
		case 'pending':
			return 'Reopen task'
		default:
			return 'Update task'
	}
}

export function presentTaskUpdateCall(input: {
	readonly status?: unknown
	readonly subject?: unknown
}): ToolCallView {
	const verb = taskUpdateVerb(input.status)
	const subject = typeof input.subject === 'string' ? oneLine(input.subject) : ''
	return activity(subject ? `${verb} · ${subject}` : verb)
}

export function presentTaskUpdateResult(_input: unknown, result: ToolResult): ToolResultView {
	if (!result.success) return failure(result, 'The task was not changed')
	return HIDDEN_RESULT
}

export function presentTaskListCall(): ToolCallView {
	return activity('Check tasks')
}

export function presentTaskListResult(_input: unknown, result: ToolResult): ToolResultView {
	if (!result.success) return { kind: 'generic', label: 'The task list could not be read' }
	const stats = (result.data as { stats?: { total?: unknown; completed?: unknown } } | undefined)
		?.stats
	const total = typeof stats?.total === 'number' ? stats.total : undefined
	const completed = typeof stats?.completed === 'number' ? stats.completed : undefined
	if (total === undefined || completed === undefined) return HIDDEN_RESULT
	return {
		kind: 'generic',
		label: total === 0 ? 'No tasks yet' : `Tasks · ${completed}/${total} done`,
	}
}
