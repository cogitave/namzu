/**
 * Task operations as transcript blocks.
 *
 * A planning step is usually several task calls in a row — three
 * `task_create`s, or a `task_update` closing one step and another opening the
 * next. Each used to leave its own tool row, with the tool's arguments and the
 * model's receipt (ids, owner, JSON) as its text. An operator reading that
 * learns the protocol and not the plan.
 *
 * So consecutive task operations in one step fold into ONE block: a header
 * saying what changed, in words (`Added 3 tasks`, `Completed · Write the
 * parser`), and the checklist as it stood afterwards. "Consecutive" is literal:
 * the block keeps growing only while it is the last row of the transcript and
 * belongs to the same turn. Anything else written in between — the model's
 * text, another tool — closes it, and the next task operation opens a new
 * one, so the transcript reads in the order things happened.
 *
 * Pure, so the grouping is testable without rendering.
 */

import { type ChecklistItem, type ChecklistStatus, checklistProgress } from './Checklist.js'
import type { TranscriptMessage } from './types.js'

/** The kernel's planning tools, whose rows this module owns. */
const TASK_TOOLS: ReadonlySet<string> = new Set(['task_create', 'task_update', 'task_list'])

export function isTaskTool(toolName: string): boolean {
	return TASK_TOOLS.has(toolName)
}

export type TaskOperationKind =
	| 'added'
	| 'started'
	| 'completed'
	| 'failed'
	| 'reopened'
	| 'renamed'
	| 'removed'

export interface TaskOperation {
	readonly kind: TaskOperationKind
	readonly subject: string
}

/** What one task event did, given what the task was before it; `null` for no visible change. */
export function taskOperationFor(
	previous: ChecklistItem | undefined,
	next: ChecklistItem,
): TaskOperation | null {
	const subject = next.subject
	if (!previous) return { kind: 'added', subject }
	if (previous.status !== next.status) {
		switch (next.status) {
			case 'in_progress':
				return { kind: 'started', subject }
			case 'completed':
				return { kind: 'completed', subject }
			case 'failed':
				return { kind: 'failed', subject }
			case 'pending':
				return { kind: 'reopened', subject }
		}
	}
	if (previous.subject !== next.subject) return { kind: 'renamed', subject }
	return null
}

/**
 * The plan after a task left it, and what the block says about it; `null`
 * operation when the task was never on this checklist (nothing visible changed).
 */
export function removeTask(
	tasks: readonly ChecklistItem[],
	id: string,
	subject: string,
): { readonly tasks: readonly ChecklistItem[]; readonly operation: TaskOperation | null } {
	const known = tasks.find((task) => task.id === id)
	if (!known) return { tasks, operation: null }
	return {
		tasks: tasks.filter((task) => task.id !== id),
		operation: { kind: 'removed', subject: subject || known.subject },
	}
}

/** Replace the task with the same id, or append it. */
export function upsertTask(
	tasks: readonly ChecklistItem[],
	item: ChecklistItem,
): readonly ChecklistItem[] {
	const index = tasks.findIndex((task) => task.id === item.id)
	return index < 0 ? [...tasks, item] : tasks.map((task, i) => (i === index ? item : task))
}

const SINGLE: Readonly<Record<TaskOperationKind, string>> = {
	added: 'Added task',
	started: 'Started',
	completed: 'Completed',
	failed: 'Failed',
	reopened: 'Reopened',
	renamed: 'Renamed task',
	removed: 'Removed task',
}

const MANY: Readonly<Record<TaskOperationKind, string>> = {
	added: 'Added',
	started: 'Started',
	completed: 'Completed',
	failed: 'Failed',
	reopened: 'Reopened',
	renamed: 'Renamed',
	removed: 'Removed',
}

function countTasks(count: number): string {
	return `${count} task${count === 1 ? '' : 's'}`
}

/** The header line of a block: what changed, else where the plan stands. */
export function taskBlockHeader(
	operations: readonly TaskOperation[],
	checklist: readonly ChecklistItem[],
): string {
	const [first] = operations
	if (!first) return checklist.length === 0 ? 'No tasks yet' : checklistProgress(checklist)
	if (operations.length === 1)
		return `${SINGLE[first.kind]} · ${first.subject.replace(/\s+/g, ' ').trim()}`
	if (operations.every((operation) => operation.kind === first.kind)) {
		return `${MANY[first.kind]} ${countTasks(operations.length)}`
	}
	return checklistProgress(checklist)
}

export interface TaskBlockInput {
	/** Identifies the turn; a block from another turn is never extended. */
	readonly key: string
	/** Id for the row if a new one is opened. */
	readonly id: string
	/** What happened; `null` refreshes the checklist without naming a change (a `task_list`). */
	readonly operation: TaskOperation | null
	/** The whole plan after the operation. */
	readonly checklist: readonly ChecklistItem[]
	/**
	 * How many finalized rows are already in native scrollback. A row printed
	 * there is never redrawn, so a block that has reached it is closed: updating
	 * it would change state nobody can see.
	 */
	readonly settled: number
	readonly glyphColor?: string
}

/** Whether `message` is a task block this input may still extend. */
function extendable(
	messages: readonly TranscriptMessage[],
	input: TaskBlockInput,
): TranscriptMessage | undefined {
	const last = messages.at(-1)
	if (!last?.taskBlock || last.taskBlock.key !== input.key || last.pending) return undefined
	const finalizedIndex = messages.slice(0, -1).filter((message) => !message.pending).length
	return finalizedIndex >= input.settled ? last : undefined
}

/**
 * The transcript after one task operation: the open block grown, or a new
 * block appended. A refresh with no open block and no tasks writes nothing.
 */
export function applyTaskOperation(
	messages: readonly TranscriptMessage[],
	input: TaskBlockInput,
): readonly TranscriptMessage[] {
	const open = extendable(messages, input)
	const operations = [
		...(open?.taskBlock?.operations ?? []),
		...(input.operation ? [input.operation] : []),
	]
	if (!open && operations.length === 0 && input.checklist.length === 0) return messages
	const row: TranscriptMessage = {
		id: open?.id ?? input.id,
		role: 'tool',
		content: taskBlockHeader(operations, input.checklist),
		glyph: '✓',
		...(input.glyphColor ? { glyphColor: input.glyphColor } : {}),
		checklist: input.checklist,
		taskBlock: { key: input.key, operations },
	}
	return open ? [...messages.slice(0, -1), row] : [...messages, row]
}

const CHECKLIST_STATUSES: ReadonlySet<string> = new Set<ChecklistStatus>([
	'pending',
	'in_progress',
	'completed',
	'failed',
])

/**
 * The kernel's `/tasks` report as a checklist, or `undefined` when its rows
 * are not task rows. The report carries id and owner columns for hosts that
 * want them; this terminal draws the plan the way the transcript does, so
 * `/tasks` shows the same marks and the same words and never an id.
 */
export function taskReportChecklist(
	rows: readonly Readonly<Record<string, unknown>>[],
): readonly ChecklistItem[] | undefined {
	const items: ChecklistItem[] = []
	for (const [index, row] of rows.entries()) {
		const { subject, status, id } = row
		if (typeof subject !== 'string' || typeof status !== 'string') return undefined
		if (!CHECKLIST_STATUSES.has(status)) return undefined
		items.push({
			id: typeof id === 'string' ? id : String(index),
			subject,
			status: status as ChecklistStatus,
		})
	}
	return items
}
