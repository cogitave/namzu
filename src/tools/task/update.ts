import { z } from 'zod'
import type { TaskId } from '../../types/ids/index.js'
import type { TaskStore } from '../../types/task/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

export function buildTaskUpdateTool(taskStore: TaskStore): ToolDefinition {
	return defineTool({
		name: 'task_update',
		description:
			'Update an existing task. Change its status (pending → in_progress → completed), edit its description, transfer ownership, or manage dependencies. Use status "deleted" to remove a task entirely.',
		inputSchema: z.object({
			id: z.string().describe('Task ID (e.g. "task_abc123")'),
			subject: z.string().optional().describe('Updated title'),
			description: z.string().optional().describe('Updated description'),
			activeForm: z.string().optional().describe('Updated present continuous form'),
			status: z
				.enum(['pending', 'in_progress', 'completed', 'deleted'])
				.optional()
				.describe('New status'),
			owner: z.string().optional().describe('Agent name to assign ownership'),
			addBlocks: z
				.array(z.string())
				.optional()
				.describe('Task IDs that this task should now block'),
			addBlockedBy: z
				.array(z.string())
				.optional()
				.describe('Task IDs that should now block this task'),
			metadata: z.record(z.string(), z.unknown()).optional().describe('Metadata to merge'),
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		async execute({
			id,
			subject,
			description,
			activeForm,
			status,
			owner,
			addBlocks,
			addBlockedBy,
			metadata,
		}) {
			const taskId = id as TaskId

			if (status === 'deleted') {
				const deleted = await taskStore.delete(taskId)
				return {
					success: deleted,
					output: deleted ? `Task ${id} deleted` : `Task ${id} not found`,
				}
			}

			if (addBlocks) {
				for (const blockedId of addBlocks) {
					await taskStore.block(taskId, blockedId as TaskId)
				}
			}
			if (addBlockedBy) {
				for (const blockerId of addBlockedBy) {
					await taskStore.block(blockerId as TaskId, taskId)
				}
			}

			const updated = await taskStore.update(taskId, {
				subject,
				description,
				activeForm,
				status: status as 'pending' | 'in_progress' | 'completed' | undefined,
				owner,
				metadata,
			})

			if (!updated) {
				return { success: false, output: `Task ${id} not found` }
			}

			return {
				success: true,
				output: `Task ${id} updated — status: ${updated.status}`,
				data: { id: updated.id, status: updated.status, owner: updated.owner },
			}
		},
	})
}
