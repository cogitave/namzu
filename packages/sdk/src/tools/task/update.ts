import { z } from 'zod'
import { TaskListError, isClaimableTaskStore } from '../../store/task/file.js'
import type { TaskStore } from '../../types/task/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { asTaskId } from '../../utils/id.js'
import { defineTool } from '../defineTool.js'
import type { TaskToolScope } from './index.js'
import { presentTaskUpdateCall, presentTaskUpdateResult } from './present.js'

export function buildTaskUpdateTool(
	taskStore: TaskStore,
	scope?: Pick<TaskToolScope, 'member'>,
): ToolDefinition {
	return defineTool({
		name: 'task_update',
		description:
			'Update task fields, owner or dependencies. Built-in statuses move forward only; completed/failed are terminal. Create follow-up tasks instead of reopening. Record failures as failed. An unconfirmed status may leave other edits applied. Outcomes are reported, not verified. Use "deleted" to remove a task that no longer applies.',
		inputSchema: z.object({
			id: z.string().describe('Task ID (e.g. "task_abc123")'),
			subject: z.string().optional().describe('Updated title'),
			description: z.string().optional().describe('Updated description'),
			activeForm: z.string().optional().describe('Updated present continuous form'),
			status: z
				.enum(['pending', 'in_progress', 'completed', 'failed', 'deleted'])
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
		presentCall: presentTaskUpdateCall,
		presentResult: presentTaskUpdateResult,
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
			// Checked. Without it a malformed id reads as "Task not found",
			// which tells the model its task disappeared rather than that it
			// named the wrong thing.
			const taskId = asTaskId(id)

			if (status === 'deleted') {
				const deleted = await taskStore.delete(taskId)
				return {
					success: deleted,
					output: deleted ? `Task ${id} deleted` : `Task ${id} not found`,
				}
			}

			// Only a list several sessions share can refuse an edge or a claim, and only it is asked to.
			const shared = isClaimableTaskStore(taskStore) ? taskStore : undefined

			try {
				if (addBlocks) {
					for (const blockedId of addBlocks) {
						await taskStore.block(taskId, asTaskId(blockedId))
					}
				}
				if (addBlockedBy) {
					for (const blockerId of addBlockedBy) {
						await taskStore.block(asTaskId(blockerId), taskId)
					}
				}
			} catch (error) {
				if (shared && error instanceof TaskListError) {
					return { success: false, output: error.message }
				}
				throw error
			}

			// Moving a shared task to in_progress is a claim: it goes to one owner, and a task that is
			// owned, closed or still waiting on a blocker says so instead of being taken.
			let claimed: Awaited<ReturnType<TaskStore['get']>>
			if (shared && status === 'in_progress') {
				const claimant = owner ?? scope?.member
				if (claimant === undefined) {
					return {
						success: false,
						output: `Task ${id} cannot move to in_progress without an owner; pass owner (your member name).`,
					}
				}
				{
					const result = await shared.claimTask(taskId, claimant)
					if (!result.ok) {
						const reason: Record<typeof result.code, string> = {
							not_found: `Task ${id} not found`,
							already_claimed: `Task ${id} is already claimed by ${result.task?.owner ?? 'another member'}`,
							already_resolved: `Task ${id} is already ${result.task?.status ?? 'closed'}; create a follow-up task instead`,
							blocked: `Task ${id} is blocked by ${result.blockedBy?.join(', ') ?? 'another task'}; finish those first`,
						}
						return {
							success: false,
							output: reason[result.code],
							data: { code: result.code },
						}
					}
					claimed = result.task
				}
			}

			// One member does not close another's task.
			if (
				shared &&
				scope?.member !== undefined &&
				(status === 'completed' || status === 'failed')
			) {
				const current = await shared.get(taskId)
				if (current?.owner !== undefined && current.owner !== scope.member) {
					return {
						success: false,
						output: `Task ${id} is owned by ${current.owner}; only its owner closes it.`,
						data: { code: 'already_claimed' },
					}
				}
			}

			let updated: Awaited<ReturnType<TaskStore['update']>>
			try {
				updated = await taskStore.update(taskId, {
					subject,
					description,
					activeForm,
					status: claimed && status === 'in_progress' ? undefined : status,
					owner: claimed ? undefined : owner,
					metadata,
				})
			} catch (error) {
				if (shared && error instanceof TaskListError) {
					return { success: false, output: error.message, data: { code: error.code } }
				}
				throw error
			}

			if (!updated) {
				return { success: false, output: `Task ${id} not found` }
			}

			// Stores can retain the old status while applying other edits. The
			// receipt describes the returned state; it cannot prove whether the
			// request was refused or a concurrent writer advanced it again.
			const statusApplied = status === undefined || updated.status === status
			return {
				success: statusApplied,
				output: statusApplied
					? `Task ${id} updated — status: ${updated.status}`
					: `Task ${id} requested status "${status}" could not be confirmed; returned status is "${updated.status}". Other requested edits may have applied. Inspect the task and create a new task for follow-up work.`,
				data: {
					id: updated.id,
					subject: updated.subject,
					status: updated.status,
					owner: updated.owner,
					...(statusApplied ? {} : { requestedStatus: status }),
				},
			}
		},
	})
}
