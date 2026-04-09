import { z } from 'zod'
import type { RunId } from '../../types/ids/index.js'
import type { TaskStore } from '../../types/task/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

export function buildTaskCreateTool(taskStore: TaskStore, runId: RunId): ToolDefinition {
	return defineTool({
		name: 'task_create',
		description:
			'Create a task to track a unit of planned work. Use this to break down complex work into trackable steps before starting. Each task has a subject (imperative: "Fix auth bug") and optionally an activeForm (present continuous: "Fixing auth bug") for progress display.',
		inputSchema: z.object({
			subject: z.string().describe('Brief title in imperative form ("Fix auth middleware")'),
			description: z.string().optional().describe('Detailed description of the work'),
			activeForm: z
				.string()
				.optional()
				.describe('Present continuous form for progress display ("Fixing auth middleware")'),
			owner: z
				.string()
				.optional()
				.describe('Agent or role this task is assigned to (e.g. "code-review", "code-writer")'),
			blockedBy: z
				.array(z.string())
				.optional()
				.describe('Task IDs that must complete before this task can start'),
			metadata: z.record(z.string(), z.unknown()).optional().describe('Free-form metadata'),
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		async execute({ subject, description, activeForm, owner, blockedBy, metadata }) {
			const task = await taskStore.create({
				runId,
				subject,
				description,
				activeForm,
				owner,
				blockedBy: blockedBy as `task_${string}`[] | undefined,
				metadata,
			})

			return {
				success: true,
				output: `Task created: ${task.id} — "${subject}"${owner ? ` [owner: ${owner}]` : ''}`,
				data: { id: task.id, status: task.status, owner: task.owner },
			}
		},
	})
}
