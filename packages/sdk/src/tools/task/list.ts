import { z } from 'zod'
import type { RunId } from '../../types/ids/index.js'
import { type TaskStore, isTerminalTaskStatus } from '../../types/task/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

export function buildTaskListTool(taskStore: TaskStore, runId: RunId): ToolDefinition {
	return defineTool({
		name: 'task_list',
		description:
			'List all tasks for the current run. Shows subject, status, owner, and unresolved blockers. Use this to review your plan and decide what to work on next.',
		inputSchema: z.object({}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute() {
			const tasks = await taskStore.list({ runId })

			const completedIds = new Set(
				tasks.filter((t) => isTerminalTaskStatus(t.status)).map((t) => t.id),
			)

			const summary = tasks.map((task) => {
				const unresolvedBlockers = task.blockedBy.filter((bid) => !completedIds.has(bid))

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
			}

			return {
				success: true,
				output:
					tasks.length === 0
						? 'No tasks yet.'
						: `${stats.total} tasks: ${stats.completed} completed, ${stats.in_progress} in progress, ${stats.pending} pending.`,
				data: { tasks: summary, stats },
			}
		},
	})
}
