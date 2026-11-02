/**
 * Where the plan stands, in one line above the composer.
 *
 * The transcript owns the checklist: each group of task operations leaves one
 * block there with the list as it stood afterwards (see `task-activity.ts`),
 * which is where Codex keeps its plan too: printed inline, once, as a plain
 * block in the conversation. This used to draw the same
 * list a second time in the live region, so an operator read every task twice
 * at once. What the live region adds is only what scrolls away: which step is
 * current and how far along the plan is. So it is one row, it names one task,
 * and it leaves when nothing is left to do — and the App does not draw it at
 * all while the newest transcript row is the checklist itself, which is then
 * on screen directly above.
 */

import { Box, Text, useWindowSize } from 'ink'
import stringWidth from 'string-width'

import { type ChecklistItem, ChecklistRow, checklistLine } from './Checklist.js'
import { theme } from './theme.js'

export type TaskListItem = ChecklistItem

export interface TaskListProps {
	readonly tasks: readonly TaskListItem[]
	/** Ctrl+T has opened the checklist: every task, up to five rows, instead of the one current step. */
	readonly expanded?: boolean
}

/** The step the operator is waiting on: the one in progress, else the next pending. */
export function currentTask(tasks: readonly TaskListItem[]): TaskListItem | undefined {
	return (
		tasks.find((task) => task.status === 'in_progress') ??
		tasks.find((task) => task.status === 'pending')
	)
}

/** The most rows the open checklist takes, overflow line included. */
export const EXPANDED_TASK_ROWS = 5

/**
 * What the open checklist shows. Up to five rows: the whole list when it fits;
 * otherwise four tasks, in list order, chosen as the one in progress first, then
 * the pending ones, then the latest finished, and a last row counting the rest.
 */
export function expandedTaskRows(tasks: readonly TaskListItem[]): {
	readonly shown: readonly TaskListItem[]
	readonly hidden: number
} {
	if (tasks.length <= EXPANDED_TASK_ROWS) return { shown: tasks, hidden: 0 }
	const room = EXPANDED_TASK_ROWS - 1
	const rank = (task: TaskListItem): number =>
		task.status === 'in_progress' ? 0 : task.status === 'pending' ? 1 : 2
	const chosen = new Set(
		tasks
			.map((task, index) => ({ task, index }))
			.sort(
				(a, b) =>
					rank(a.task) - rank(b.task) ||
					(rank(a.task) === 2 ? b.index - a.index : a.index - b.index),
			)
			.slice(0, room)
			.map(({ index }) => index),
	)
	return {
		shown: tasks.filter((_, index) => chosen.has(index)),
		hidden: tasks.length - room,
	}
}

/** Rows this component occupies, for the live-region budget. */
export function taskListRows(tasks: readonly TaskListItem[], expanded = false): number {
	if (expanded) {
		if (tasks.length === 0) return 0
		const { shown, hidden } = expandedTaskRows(tasks)
		return shown.length + (hidden > 0 ? 1 : 0)
	}
	return currentTask(tasks) ? 1 : 0
}

export function TaskList({ tasks, expanded = false }: TaskListProps) {
	const { columns } = useWindowSize()
	if (expanded) {
		if (tasks.length === 0) return null
		const { shown, hidden } = expandedTaskRows(tasks)
		return (
			<Box flexDirection="column" paddingLeft={2}>
				{shown.map((task) => (
					<ChecklistRow key={task.id} item={task} wrap="truncate-end" />
				))}
				{hidden > 0 ? <Text color={theme.text.muted}>… +{hidden} more</Text> : null}
			</Box>
		)
	}
	const current = currentTask(tasks)
	if (!current) return null
	const done = tasks.filter((task) => task.status === 'completed').length
	const count = ` · ${done}/${tasks.length} done`
	// The step leads and the count follows. When both do not fit, the count is
	// what goes: the step is the one thing this row is for. The four columns
	// are this row's indent and the App's own horizontal padding.
	const room = Math.max(0, columns - 4)
	const showCount = stringWidth(checklistLine(current)) + stringWidth(count) <= room
	return (
		<Box flexDirection="row" paddingLeft={2}>
			<Box flexShrink={1}>
				<ChecklistRow item={current} wrap="truncate-end" />
			</Box>
			{showCount ? (
				<Box flexShrink={0}>
					<Text color={theme.text.muted}>{count}</Text>
				</Box>
			) : null}
		</Box>
	)
}
