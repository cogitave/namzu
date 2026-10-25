import type { ChecklistItem } from './Checklist.js'

/**
 * The task the plan reaches next: the first pending one whose blockers are all
 * finished, else the first pending one. Undefined when nothing is pending.
 * `blockedBy` names tasks by id; a blocker that is not on the list counts as
 * finished, because nothing on screen could still be waiting on it.
 */
export function nextTask(tasks: readonly ChecklistItem[]): ChecklistItem | undefined {
	const pending = tasks.filter((task) => task.status === 'pending')
	if (pending.length === 0) return undefined
	const open = new Set(tasks.filter((task) => task.status !== 'completed').map((task) => task.id))
	return pending.find((task) => !(task.blockedBy ?? []).some((id) => open.has(id))) ?? pending[0]
}

/** The `Next:` line's text: whitespace collapsed to single spaces. */
export function nextTaskLine(task: ChecklistItem): string {
	return `Next: ${task.subject.replace(/\s+/gu, ' ').trim()}`
}
