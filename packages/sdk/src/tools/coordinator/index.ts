import { z } from 'zod'
import type { PlanManager } from '../../manager/plan/lifecycle.js'
import type { AgentRuntimeContext } from '../../types/agent/base.js'
import type { TaskGateway } from '../../types/agent/gateway.js'
import type { RunId, TaskId } from '../../types/ids/index.js'
import type { TaskStore } from '../../types/task/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

export type TaskLaunchedCallback = (
	agentTaskId: TaskId,
	meta: {
		agentId: string
		description: string
		planTaskId?: string
	},
) => void

export interface CoordinatorToolsOptions {
	gateway: TaskGateway
	workingDirectory: string
	runtimeContext?: AgentRuntimeContext
	allowedAgentIds: string[]

	taskStore?: TaskStore

	runId?: RunId

	getPlanManager?: () => PlanManager | undefined

	onTaskLaunched?: TaskLaunchedCallback
}

export function buildCoordinatorTools(opts: CoordinatorToolsOptions): ToolDefinition[] {
	const {
		gateway,
		allowedAgentIds: agentIds,
		taskStore,
		runId,
		getPlanManager,
		onTaskLaunched,
	} = opts
	const cwd = opts.workingDirectory

	const agentIdEnum = agentIds.length > 0 ? z.enum(agentIds as [string, ...string[]]) : z.string()

	const createTask = defineTool({
		name: 'create_task',
		description: `Launch a task on a specialized agent. NON-BLOCKING: returns immediately. You will receive a <task-notification> message when the agent finishes. Available agents: ${agentIds.join(', ')}. The agent cannot see your conversation — include ALL necessary context in the prompt. To launch multiple tasks in parallel, call this tool multiple times in a single response. After launching, briefly tell the user what you launched and end your turn — do NOT predict or fabricate results.`,
		inputSchema: z.object({
			agent_id: agentIdEnum.describe('Which agent to run'),
			prompt: z
				.string()
				.describe('Self-contained task description with all context the agent needs'),
			description: z.string().describe('Short summary for tracking (shown to user)'),
			plan_task_id: z
				.string()
				.optional()
				.describe(
					'Existing planning task ID to link. If omitted, a planning task is auto-created.',
				),
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		async execute({ agent_id, prompt, description, plan_task_id }) {
			let resolvedPlanTaskId = plan_task_id

			if (taskStore) {
				if (resolvedPlanTaskId) {
					await taskStore.update(resolvedPlanTaskId as `task_${string}`, {
						status: 'in_progress',
						owner: agent_id,
					})
				} else if (runId) {
					const planTask = await taskStore.create({
						runId,
						subject: description,
						activeForm: description,
						owner: agent_id,
					})
					await taskStore.update(planTask.id, { status: 'in_progress' })
					resolvedPlanTaskId = planTask.id
				}
			}

			const handle = await gateway.createTask({
				agentId: agent_id,
				prompt,
				workingDirectory: cwd,
				runtimeContext: opts.runtimeContext,
			})

			if (onTaskLaunched) {
				onTaskLaunched(handle.taskId, {
					agentId: agent_id,
					description,
					planTaskId: resolvedPlanTaskId,
				})
			}

			return {
				success: true,
				output: `Task launched: ${handle.taskId} → ${agent_id} ("${description}"). You will receive a task-notification when it completes.`,
				data: {
					task_id: handle.taskId,
					agent_id,
					description,
					state: 'running',
					plan_task_id: resolvedPlanTaskId,
				},
			}
		},
	})

	const continueTask = defineTool({
		name: 'continue_task',
		description:
			'Send a follow-up message to a previously completed task. NON-BLOCKING: the agent resumes in the background with full prior context. You will receive a task-notification when it finishes. Only use this with a task_id from a previous create_task or task-notification.',
		inputSchema: z.object({
			task_id: z
				.string()
				.describe('Agent task ID from a previous create_task or task-notification'),
			message: z.string().describe('Follow-up instruction for the agent'),
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		async execute({ task_id, message }) {
			await gateway.continueTask(task_id as TaskId, message)

			return {
				success: true,
				output: `Follow-up sent to ${task_id}. You will receive a task-notification when it finishes.`,
				data: { task_id, state: 'running' },
			}
		},
	})

	const cancelTask = defineTool({
		name: 'cancel_task',
		description:
			'Cancel a running agent task. Only use this with a task_id from a previous create_task.',
		inputSchema: z.object({
			task_id: z.string().describe('Agent task ID from a previous create_task'),
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		async execute({ task_id }) {
			gateway.cancelTask(task_id as TaskId)
			return {
				success: true,
				output: `Task ${task_id} cancelled`,
				data: { task_id },
			}
		},
	})

	const tools: ToolDefinition[] = [createTask, continueTask, cancelTask]

	if (getPlanManager) {
		const approvePlan = defineTool({
			name: 'approve_plan',
			description:
				'Present your execution plan to the user for approval before launching workers. Call this after you have analyzed the request and determined what tasks to run. The user can approve, reject with feedback, or modify the plan. Only proceed with create_task after approval.',
			inputSchema: z.object({
				title: z
					.string()
					.describe('Short title for the plan (e.g. "TypeScript Security & Performance Review")'),
				summary: z.string().describe('1-3 sentence summary of what you plan to do'),
				steps: z
					.array(
						z.object({
							description: z.string().describe('What this step does'),
							agent_id: z
								.string()
								.optional()
								.describe('Which agent handles this (omit for orchestrator-owned steps)'),
							depends_on: z
								.array(z.string())
								.optional()
								.describe('Step descriptions this depends on'),
						}),
					)
					.describe('Ordered list of planned steps'),
			}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			async execute({ title, summary, steps }) {
				const pm = getPlanManager()
				if (!pm) {
					return {
						success: false,
						output: 'Plan approval is not available — proceed directly with create_task.',
						data: { approved: true },
					}
				}

				pm.startGenerating(title)
				for (let i = 0; i < steps.length; i++) {
					const step = steps[i]
					if (!step) throw new Error(`Plan step at index ${i} is undefined`)
					pm.addStep({
						id: `step_${i + 1}`,
						description: step.description,
						toolName: step.agent_id ? 'create_task' : undefined,
						dependsOn: [],
						order: i + 1,
					})
				}
				pm.markReady(summary)

				const response = await pm.requestApproval()

				if (response.approved) {
					pm.startExecution()
					return {
						success: true,
						output:
							'Plan approved by user. Proceed with execution — launch workers via create_task.',
						data: { approved: true, feedback: response.feedback },
					}
				}

				return {
					success: false,
					output: `Plan rejected. User feedback: ${response.feedback ?? 'No feedback provided'}. Revise your plan based on this feedback and call approve_plan again, or ask the user for clarification.`,
					data: { approved: false, feedback: response.feedback },
				}
			},
		})
		tools.push(approvePlan)
	}

	return tools
}
