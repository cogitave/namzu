import type { AcpTask, AcpTaskUpdate } from '@namzu/sdk'

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/** Admit only the public planning fields; raw task metadata never reaches a renderer. */
export function readTask(value: unknown): AcpTask | undefined {
	if (
		!object(value) ||
		!id(value.taskId) ||
		typeof value.subject !== 'string' ||
		typeof value.status !== 'string' ||
		!['pending', 'in_progress', 'completed', 'failed'].includes(value.status) ||
		!Array.isArray(value.blockedBy) ||
		!value.blockedBy.every(id) ||
		(value.owner !== undefined && typeof value.owner !== 'string')
	)
		return undefined
	return {
		taskId: value.taskId,
		subject: value.subject,
		status: value.status as AcpTask['status'],
		blockedBy: [...value.blockedBy],
		...(value.owner === undefined ? {} : { owner: value.owner }),
	}
}
export function readTaskUpdate(value: unknown): AcpTaskUpdate | undefined {
	if (
		!object(value) ||
		!id(value.sessionId) ||
		(value.deleted !== undefined && value.deleted !== true)
	)
		return undefined
	const task = readTask(value.task)
	return task
		? { sessionId: value.sessionId, task, ...(value.deleted === true ? { deleted: true } : {}) }
		: undefined
}
export function readTasks(value: unknown): AcpTask[] | undefined {
	if (!object(value) || !Array.isArray(value.tasks)) return undefined
	const tasks: AcpTask[] = []
	const ids = new Set<string>()
	for (const entry of value.tasks) {
		const task = readTask(entry)
		if (!task || ids.has(task.taskId)) return undefined
		ids.add(task.taskId)
		tasks.push(task)
	}
	return tasks
}
