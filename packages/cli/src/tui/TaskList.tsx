/**
 * The model's plan for the current request, live.
 *
 * `task_create` / `task_update` used to reach the operator as two transcript
 * rows — "☐ subject" when a task was opened and "☑ subject" when it closed —
 * and nothing in between. A plan with five steps was therefore five rows
 * scattered through the tool output, with no way to see which step was
 * current or how many were left. That is a record, not a plan; the operator
 * following along needs the whole list with its state, in one place, kept
 * current as the model works.
 *
 * So this sits in the live region above the composer, like the delegated
 * work panel does below it: present while the request has tasks, redrawn on
 * every status change, cleared when the next request begins. The transcript
 * rows stay — they are the durable record once this leaves the screen.
 */

import { Box, Text } from 'ink'

import { terminalDisplayText } from './terminal-display.js'
import { theme } from './theme.js'

export type TaskListStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface TaskListItem {
	readonly id: string
	readonly subject: string
	readonly status: TaskListStatus
}

export interface TaskListProps {
	readonly tasks: readonly TaskListItem[]
	/** Rows before the remainder is summarised as a count. */
	readonly maxRows?: number
}

const DEFAULT_MAX_ROWS = 8

const MARK: Record<TaskListStatus, string> = {
	pending: '☐',
	in_progress: '◐',
	completed: '☑',
	failed: '☒',
}

export function isTerminalTaskStatus(status: TaskListStatus): boolean {
	return status === 'completed' || status === 'failed'
}

export function TaskList({ tasks, maxRows = DEFAULT_MAX_ROWS }: TaskListProps) {
	if (tasks.length === 0) return null
	const done = tasks.filter((task) => task.status === 'completed').length
	const failed = tasks.filter((task) => task.status === 'failed').length
	// The current step is the one the operator is waiting on; when the list
	// is longer than the window, show the window that contains it rather than
	// the first eight steps of a plan already past them.
	const current = tasks.findIndex((task) => task.status === 'in_progress')
	const start =
		tasks.length <= maxRows ? 0 : Math.max(0, Math.min(current, tasks.length - maxRows))
	const visible = tasks.slice(start, start + maxRows)
	const before = start
	const after = tasks.length - start - visible.length

	return (
		<Box flexDirection="column" paddingLeft={2}>
			<Text color={theme.text.muted}>
				Tasks · {done}/{tasks.length} done{failed > 0 ? ` · ${failed} failed` : ''}
			</Text>
			{before > 0 ? <Text color={theme.text.muted}>  ↑ {before} more</Text> : null}
			{visible.map((task) => (
				<Box key={task.id} flexDirection="row">
					<Text color={markColor(task.status)}>{MARK[task.status]} </Text>
					<Text
						color={task.status === 'completed' ? theme.text.muted : theme.text.primary}
						strikethrough={task.status === 'completed'}
						wrap="truncate-end"
					>
						{terminalDisplayText(task.subject)}
					</Text>
				</Box>
			))}
			{after > 0 ? <Text color={theme.text.muted}>  ↓ {after} more</Text> : null}
		</Box>
	)
}

function markColor(status: TaskListStatus): string {
	switch (status) {
		case 'in_progress':
			return theme.accent.tool
		case 'completed':
			return theme.status.ok
		case 'failed':
			return theme.status.error
		default:
			return theme.text.secondary
	}
}
