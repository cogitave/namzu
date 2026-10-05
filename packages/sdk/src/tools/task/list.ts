import { z } from 'zod'
import { selectTaskContext } from '../../store/task/context.js'
import { type TaskStore, isTerminalTaskStatus } from '../../types/task/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import type { TaskToolScope } from './index.js'
import { countTasks, presentTaskListCall, presentTaskListResult } from './present.js'

export function buildTaskListTool(
	taskStore: TaskStore,
	scope: TaskToolScope & { readonly turnStartedAt: number },
): ToolDefinition {
	return defineTool({
		name: 'task_list',
		description:
			'List planning items for this session: every open one, and those closed during the current turn. Earlier completed or failed items remain stored but are omitted; returned tasks and stats count only this current-turn view, not the full stored history. Not delegated agent invocations. Use agent_task_list, when available, to inspect agent execution. Shows subject, status, owner, and unresolved blockers. Use this to review your plan and decide what to work on next.',
		inputSchema: z.object({}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		presentCall: presentTaskListCall,
		presentResult: presentTaskListResult,
		async execute() {
			const all = await taskStore.list({ sessionId: scope.sessionId })
			// Blockers resolve against every task of the session, shown or not: a
			// blocker closed in an earlier turn is resolved, not unknown.
			const terminalIds = new Set(
				all.filter((t) => isTerminalTaskStatus(t.status)).map((t) => t.id),
			)
			const tasks = selectTaskContext(all, scope)

			const summary = tasks.map((task) => {
				const unresolvedBlockers = task.blockedBy.filter((bid) => !terminalIds.has(bid))

				return {
					id: task.id,
					subject: task.subject,
					status: task.status,
					owner: task.owner ?? null,
					blockedBy: unresolvedBlockers.length > 0 ? unresolvedBlockers : undefined,
					activeForm: task.status === 'in_progress' ? task.activeForm : undefined,
				}
			})

			const stats = {
				total: tasks.length,
				pending: tasks.filter((t) => t.status === 'pending').length,
				in_progress: tasks.filter((t) => t.status === 'in_progress').length,
				completed: tasks.filter((t) => t.status === 'completed').length,
				failed: tasks.filter((t) => t.status === 'failed').length,
			}
			const omitted = all.length - tasks.length
			const history = omitted
				? ` ${countTasks(omitted)} closed in earlier turns ${omitted === 1 ? 'remains' : 'remain'} stored and ${omitted === 1 ? 'is' : 'are'} omitted from this view.`
				: ''
			const output =
				all.length === 0
					? 'No planning tasks found for this session. This list does not report delegated agent status; use agent_task_list when available.'
					: tasks.length === 0
						? `No open or current-turn planning tasks.${history}`
						: `Current-turn view: ${countTasks(stats.total)}: ${stats.completed} completed, ${stats.in_progress} in progress, ${stats.pending} pending${stats.failed ? `, ${stats.failed} failed` : ''}.${history}`

			return {
				success: true,
				output,
				data: { tasks: summary, stats },
			}
		},
	})
}
