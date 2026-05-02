import { z } from 'zod'

import type { AgentRuntimeContext } from '../../types/agent/base.js'
import type { TaskGateway } from '../../types/agent/gateway.js'
import type { RunId } from '../../types/ids/index.js'
import type { TaskStore } from '../../types/task/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

import type { TaskLaunchedCallback } from './index.js'

/**
 * Build the canonical Claude Code `Agent` tool — synchronous subagent
 * delegation that mirrors what Claude is trained against in
 * `code.claude.com/docs/en/sub-agents`.
 *
 * Semantics: parent calls `Agent({ description, prompt, subagent_type })`,
 * the runtime spawns the chosen subagent with its own context window,
 * the parent's tool call BLOCKS until the subagent finishes, and the
 * subagent's final text comes back as the tool result. Intermediate
 * subagent tool calls are isolated — only the summary surfaces to
 * the parent.
 *
 * This is **NOT** the same shape as the legacy `create_task` /
 * `continue_task` / `cancel_task` trio that this package ships
 * alongside it: those are non-blocking and use a `<task-notification>`
 * callback model. The async pattern is useful for hosts that want a
 * work-queue surface, but it is not what Claude Code trained against.
 * For free agentic alignment, prefer the canonical `Agent` tool; keep
 * the legacy coordinator tools only when you genuinely need
 * fire-and-forget multi-task fan-out.
 */
export interface AgentToolOptions {
	gateway: TaskGateway
	workingDirectory: string
	runtimeContext?: AgentRuntimeContext
	allowedAgentIds: string[]

	taskStore?: TaskStore

	runId?: RunId

	onTaskLaunched?: TaskLaunchedCallback
}

export function buildAgentTool(opts: AgentToolOptions): ToolDefinition {
	const { gateway, allowedAgentIds: agentIds, taskStore, runId, onTaskLaunched } = opts
	const cwd = opts.workingDirectory

	const subagentTypeEnum =
		agentIds.length > 0 ? z.enum(agentIds as [string, ...string[]]) : z.string()

	return defineTool({
		name: 'Agent',
		description: `Delegate a task to a specialized subagent. BLOCKING: returns when the subagent has finished, with the subagent's final text as the tool result. The subagent runs in its own context window and cannot see your conversation — include all necessary context in the prompt. Available subagents: ${agentIds.join(', ')}. To run multiple subagents in parallel, call this tool multiple times in a single response.`,
		inputSchema: z.object({
			description: z.string().describe('Short label for tracking (shown to the user)'),
			prompt: z
				.string()
				.describe('Self-contained task description with all context the subagent needs'),
			subagent_type: subagentTypeEnum.describe('Which subagent to run'),
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		async execute({ description, prompt, subagent_type }) {
			let planTaskId: string | undefined

			if (taskStore && runId) {
				const planTask = await taskStore.create({
					runId,
					subject: description,
					activeForm: description,
					owner: subagent_type,
				})
				await taskStore.update(planTask.id, { status: 'in_progress' })
				planTaskId = planTask.id
			}

			const handle = await gateway.createTask({
				agentId: subagent_type,
				prompt,
				workingDirectory: cwd,
				runtimeContext: opts.runtimeContext,
			})

			onTaskLaunched?.(handle.taskId, {
				agentId: subagent_type,
				description,
				planTaskId,
			})

			const completed = await gateway.waitForTask(handle.taskId)

			if (taskStore && planTaskId && completed.state === 'completed') {
				await taskStore.update(planTaskId as `task_${string}`, {
					status: 'completed',
				})
			}

			const resultText =
				typeof completed.result?.result === 'string'
					? completed.result.result
					: JSON.stringify(completed.result?.result ?? null)

			if (completed.state !== 'completed') {
				return {
					success: false,
					output: '',
					error: `Subagent ${subagent_type} ${completed.state}: ${resultText || '(no result)'}`,
					data: {
						task_id: handle.taskId,
						subagent_type,
						state: completed.state,
					},
				}
			}

			return {
				success: true,
				output: resultText || '(subagent returned no text)',
				data: {
					task_id: handle.taskId,
					subagent_type,
					state: completed.state,
				},
			}
		},
	})
}
