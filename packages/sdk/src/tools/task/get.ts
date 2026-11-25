import { z } from 'zod'
import type { ClaimableTaskStore } from '../../store/task/file.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { asTaskId } from '../../utils/id.js'
import { defineTool } from '../defineTool.js'
import { taskNumbers } from './number.js'

/**
 * Read one task in full: its description, owner and what it waits on. Only for a list several
 * sessions share, where a teammate reads a task before it takes it.
 */
export function buildTaskGetTool(taskStore: ClaimableTaskStore): ToolDefinition {
	return defineTool({
		name: 'task_get',
		description:
			'Read one task in full: subject, description, status, owner, what it blocks and what blocks it. Read a task before you start it. A blocker only stops a task until that blocker is completed.',
		inputSchema: z.object({
			id: z.string().describe('Task ID'),
		}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute({ id }) {
			const task = await taskStore.get(asTaskId(id))
			if (!task) return { success: false, output: `Task ${id} not found` }
			const waiting = await taskStore.unresolvedBlockers(task)
			const numbers = await taskNumbers(taskStore)
			const number = numbers.get(task.id)
			const data = {
				id: task.id,
				...(number === undefined ? {} : { number }),
				subject: task.subject,
				description: task.description ?? null,
				status: task.status,
				owner: task.owner ?? null,
				blocks: task.blocks,
				blockedBy: task.blockedBy,
				waitingOn: waiting,
				activeForm: task.activeForm ?? null,
				metadata: task.metadata ?? null,
			}
			const lines = [
				`${number === undefined ? '' : `#${number} `}${task.subject} [${task.status}]${task.owner ? ` owner: ${task.owner}` : ''}`,
				...(task.description ? [task.description] : []),
				...(waiting.length > 0 ? [`Waiting on: ${waiting.join(', ')}`] : []),
				...(task.blocks.length > 0 ? [`Blocks: ${task.blocks.join(', ')}`] : []),
			]
			return { success: true, output: lines.join('\n'), data }
		},
	})
}
