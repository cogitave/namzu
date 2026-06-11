import { z } from 'zod'
import type { PlanManager } from '../../manager/plan/lifecycle.js'
import type { AgentRuntimeContext } from '../../types/agent/base.js'
import type { TaskGateway } from '../../types/agent/gateway.js'
import type { ResumeHandler, UserQuestionOption } from '../../types/hitl/index.js'
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
		/**
		 * The assistant `tool_use_id` that dispatched this task.
		 * Threaded from `ToolContext.toolUseId` so the runtime can
		 * later emit a canonical `tool_result` content block bound
		 * to the same id when the background task completes.
		 */
		originalToolUseId?: string
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

	/**
	 * HITL park channel for `ask_user_question`. The tool is registered
	 * only when BOTH `resumeHandler` and `runId` are present — without a
	 * handler there is no one to route the question to, and without a
	 * runId the park request cannot be addressed.
	 */
	resumeHandler?: ResumeHandler
}

const approvePlanStepSchema = z.object({
	description: z.string().describe('What this step does'),
	agent_id: z
		.string()
		.optional()
		.describe('Which agent handles this (omit for orchestrator-owned steps)'),
	depends_on: z.array(z.string()).optional().describe('Step descriptions this depends on'),
})

function normalizeApprovePlanSteps(value: unknown): unknown {
	if (typeof value !== 'string') return value

	const trimmed = value.trim()
	if (!trimmed) return []

	if (trimmed.startsWith('[')) {
		try {
			return JSON.parse(trimmed)
		} catch {
			// Fall through to plain-text line parsing.
		}
	}

	const lines = trimmed
		.split(/\r?\n+/)
		.map((line) =>
			line
				.trim()
				.replace(/^(?:[-*•]|\d+[.)])\s*/, '')
				.trim(),
		)
		.filter(Boolean)

	return (lines.length ? lines : [trimmed]).map((description) => ({
		description,
	}))
}

export function buildCoordinatorTools(opts: CoordinatorToolsOptions): ToolDefinition[] {
	const {
		gateway,
		allowedAgentIds: agentIds,
		taskStore,
		runId,
		getPlanManager,
		resumeHandler,
		// `onTaskLaunched` was the entry point for the old
		// non-blocking + envelope-injection flow. create_task is now
		// blocking, so the callback is no longer wired here.
		// Intentionally not destructured to keep the unused-binding
		// lint clean; callers can still pass it for backwards
		// compatibility (Agent tool consumes it from its own path).
	} = opts
	const cwd = opts.workingDirectory
	void opts.onTaskLaunched

	const agentIdEnum = agentIds.length > 0 ? z.enum(agentIds as [string, ...string[]]) : z.string()

	const createTask = defineTool({
		name: 'create_task',
		description: `Launch a task on a specialized agent and await its result. BLOCKING: returns the agent's final output as this call's tool_result. Available agents: ${agentIds.join(', ')}. Prefer compact assignments; for large context, write/read shared workspace files and pass filenames or references. To launch multiple tasks in parallel, call this tool multiple times in a single assistant turn — the runtime executes every tool_use block from one response concurrently and delivers all tool_results together, so 'fan out 8 specialists' is one assistant message with 8 create_task blocks.`,
		inputSchema: z.object({
			agent_id: agentIdEnum.describe('Which agent to run'),
			prompt: z
				.string()
				.describe(
					'Self-contained assignment for the agent. For large generated content, prefer workspace file references so provider output-token limits do not cut off the tool call.',
				),
			description: z.string().describe('Short summary for tracking, shown to the user.'),
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
		async execute({ agent_id, prompt, description, plan_task_id }, _context) {
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

			// Industrial-standard Anthropic tool pattern: tool returns
			// its real result as the tool_result for the dispatching
			// tool_use. Parallel fan-out happens at the executor layer
			// — when the supervisor emits N create_task blocks in one
			// assistant turn, the runtime runs them with Promise.all
			// and delivers all N tool_results together. No async
			// envelope injection, no second tool_result for the same
			// tool_use_id (which Anthropic rejects with 400).
			const completed = await gateway.waitForTask(handle.taskId)
			const success = completed.state === 'completed'
			const resultText =
				completed.result?.result ??
				completed.result?.lastError ??
				`Task finished with state: ${completed.state}`

			if (resolvedPlanTaskId && taskStore) {
				await taskStore.update(resolvedPlanTaskId as `task_${string}`, {
					status: 'completed',
					description: success ? undefined : `Failed: ${resultText.substring(0, 200)}`,
				})
			}

			return {
				success,
				output: resultText,
				data: {
					task_id: handle.taskId,
					agent_id,
					description,
					state: completed.state,
					plan_task_id: resolvedPlanTaskId,
				},
			}
		},
	})

	const continueTask = defineTool({
		name: 'continue_task',
		description:
			"Send a follow-up message to a previously completed task and await the agent's next reply. BLOCKING: returns the agent's new output as this call's tool_result, the same shape as create_task. Only use this with a task_id from a previous create_task. To run multiple follow-ups in parallel, call this tool multiple times in a single assistant turn.",
		inputSchema: z.object({
			task_id: z.string().describe('Agent task ID from a previous create_task'),
			message: z.string().describe('Follow-up instruction for the agent'),
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		async execute({ task_id, message }) {
			await gateway.continueTask(task_id as TaskId, message)
			// Mirror create_task's blocking pattern: await the new
			// completion and return the agent's output inline. The
			// previous non-blocking shape ('You will receive a
			// task-notification…') relied on a global
			// onTaskCompleted listener that the iteration loop
			// no longer registers (envelope path is dead).
			const completed = await gateway.waitForTask(task_id as TaskId)
			const success = completed.state === 'completed'
			const resultText =
				completed.result?.result ??
				completed.result?.lastError ??
				`Task finished with state: ${completed.state}`
			return {
				success,
				output: resultText,
				data: { task_id, state: completed.state },
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

	const agentTaskList = defineTool({
		name: 'agent_task_list',
		description:
			"Inspect the live state of every agent task launched on this gateway via create_task: returns each task's id, agent, state (pending/running/completed/failed/canceled), and timing. Distinct from the plan-task store's `task_list` (which lists planning tasks): this tool lists running/completed worker invocations. Use it BEFORE declaring multi-worker work done — confirm every launched task reached `completed`, none still `running` or `failed`. Read-only and safe to call repeatedly.",
		inputSchema: z.object({
			state: z
				.enum(['pending', 'running', 'completed', 'failed', 'canceled'])
				.optional()
				.describe('Filter by terminal/non-terminal state. Omit to list every task.'),
		}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute({ state }) {
			const handles = gateway.listTasks()
			const filtered = state ? handles.filter((h) => h.state === state) : handles
			const items = filtered.map((h) => {
				const runStatus = h.result?.status
				const lastError = h.result?.lastError ?? undefined
				return {
					task_id: h.taskId,
					agent_id: h.agentId,
					state: h.state,
					run_status: runStatus,
					created_at: new Date(h.createdAt).toISOString(),
					completed_at: h.completedAt ? new Date(h.completedAt).toISOString() : null,
					duration_ms: h.completedAt ? h.completedAt - h.createdAt : null,
					last_error: lastError,
				}
			})
			const summary = {
				total: handles.length,
				running: handles.filter((h) => h.state === 'running').length,
				completed: handles.filter((h) => h.state === 'completed').length,
				failed: handles.filter((h) => h.state === 'failed').length,
				canceled: handles.filter((h) => h.state === 'canceled').length,
			}
			const lines = items.length
				? items.map(
						(i) =>
							`- ${i.task_id} → ${i.agent_id} [${i.state}${i.run_status && i.run_status !== i.state ? ` / ${i.run_status}` : ''}]${
								i.duration_ms !== null ? ` (${Math.round(i.duration_ms / 1000)}s)` : ''
							}${i.last_error ? ` — error: ${i.last_error.slice(0, 200)}` : ''}`,
					)
				: ['(no tasks launched yet)']
			const header = `Tasks: ${summary.total} total — ${summary.running} running, ${summary.completed} completed, ${summary.failed} failed, ${summary.canceled} canceled`
			return {
				success: true,
				output: [header, '', ...lines].join('\n'),
				data: { items, summary },
			}
		},
	})

	// `continue_task` was a follow-up channel for a still-alive worker
	// task. With `create_task` now blocking + tool_result returning
	// the worker's final output, every worker reaches a terminal
	// state by the time the supervisor wants to follow up — and the
	// agent manager rejects `continue` on terminal tasks. The
	// industrial pattern is to issue a fresh `create_task` that
	// references the prior worker's output path, so we drop
	// `continue_task` from the registered surface entirely. The
	// definition stays in this file for now in case a future
	// non-default gateway (one that keeps the worker process alive
	// for follow-ups) wants to re-register it.
	void continueTask
	const tools: ToolDefinition[] = [createTask, cancelTask, agentTaskList]

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
					.preprocess(normalizeApprovePlanSteps, z.array(approvePlanStepSchema))
					.describe('Ordered list of planned steps'),
			}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			// Parks through the SAME runId-keyed host resume registry as
			// ask_user_question — concurrent parks in one batch clobber the
			// registry entry and deadlock the loser, so the executor must
			// serialize this tool exactly like the question tool.
			concurrencySafe: false,
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
					// Approve-with-edits: when the user attached feedback to an
					// approval, embed it in the model-visible output so the
					// supervisor applies the edits during execution. A bare
					// approve keeps the historical output byte-identical.
					const output = response.feedback
						? `Plan approved by user with required edits — apply them during execution:\n${response.feedback}\nProceed with execution — launch workers via create_task.`
						: 'Plan approved by user. Proceed with execution — launch workers via create_task.'
					return {
						success: true,
						output,
						data: { approved: true, feedback: response.feedback },
					}
				}

				// Rejection guidance follows the FEEDBACK, not a baked-in
				// revise loop: the old unconditional "revise … and call
				// approve_plan again" contradicted stop-style feedback, so a
				// user rejecting a plan got another plan instead of a halt.
				return {
					success: false,
					output: `Plan rejected. User feedback: ${response.feedback ?? 'No feedback provided'}. Follow this feedback: if it requests changes, revise your plan and call approve_plan again; if it asks you to stop, acknowledge briefly and end your turn. If no feedback was provided, ask the user how to proceed before planning again.`,
					data: { approved: false, feedback: response.feedback },
				}
			},
		})
		tools.push(approvePlan)
	}

	if (resumeHandler && runId) {
		const parkRunId = runId
		const parkHandler = resumeHandler
		const askUserQuestion = defineTool({
			name: 'ask_user_question',
			description:
				'Ask the user ONE question ONLY when you are blocked on a decision that is genuinely theirs to make — one you cannot resolve from their request, your tools, the files you can read, or sensible defaults. The question must be the genuinely undecidable thing in THIS task. Never ask for information a tool can discover (do not ask what you can read, list, or search), never re-ask what the conversation already answers, and never ask meta-questions like "Shall I proceed?" — plan ratification goes through approve_plan. Provide 2-4 genuinely distinct options derived from the actual context — concrete paths, never generic placeholders (for example, asked to prepare a presentation, ask "Who is the audience?" with options like Board / Engineering team / Customer); keep labels short (1-5 words) and give each option a one-line description of what practically changes if it is chosen. Put your recommended option FIRST and append " (Recommended)" to its label. Set multiSelect: true only when several options can apply at once. A free-text "Something else" escape hatch is always shown automatically — do not add your own "Other" option. Ask ONE question per call and prefer at most one question per assistant turn; if several decisions block you, ask only the ones that materially change your next actions, in sequence — most work needs at most 2-3 questions, so prefer proceeding on stated defaults over interrogating the user. Never invent answers or synthetic content on the user\'s behalf unless they explicitly asked for a random/test scenario. The answer arrives as this tool\'s result; if the result says the user did not answer, do not ask this or any other question again — proceed on your best judgment without assuming consent.',
			inputSchema: z.object({
				question: z
					.string()
					.min(1)
					.describe('Full question text — clear, specific, ends with a question mark.'),
				header: z
					.string()
					.max(24)
					.optional()
					.describe('Very short topic label for the question (e.g. "Audience", "Auth method").'),
				options: z
					.array(
						z.object({
							label: z
								.string()
								.min(1)
								.max(80)
								.describe(
									'Concise option label (1-5 words). Recommended option goes first with " (Recommended)" appended.',
								),
							description: z
								.string()
								.max(300)
								.optional()
								.describe('One line on what practically changes if this option is chosen.'),
						}),
					)
					.min(2)
					.max(4)
					.describe('2-4 genuinely distinct, context-derived options.'),
				multiSelect: z
					.boolean()
					.optional()
					.default(false)
					.describe('True only when several options can apply at once.'),
				allowFreeText: z
					.boolean()
					.optional()
					.default(true)
					.describe('Whether the user may answer in their own words.'),
			}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			// MUST stay false: the executor serializes non-concurrency-safe
			// tools in a single chain, so N question blocks in one assistant
			// turn park strictly one-at-a-time. Hosts key their park/resolve
			// registries by runId — concurrent parks on one run clobber each
			// other and the first promise never resolves (run hangs to TTL).
			concurrencySafe: false,
			async execute({ question, header, options, multiSelect, allowFreeText }, context) {
				const toolUseId = context.toolUseId
				if (!toolUseId) {
					// Without the executing tool_use_id the question has no
					// stable identity: the host could never merge the awaiting
					// card with its resolution, and answers could not be matched
					// back. Hard-fail instead of parking an unmergeable id.
					return {
						success: false,
						output: '',
						error:
							'ask_user_question requires an executor that threads ToolContext.toolUseId; the question cannot be tracked without it.',
					}
				}

				const questionOptions: UserQuestionOption[] = options.map((opt, i) => ({
					id: `opt_${i + 1}`,
					label: opt.label,
					...(opt.description !== undefined ? { description: opt.description } : {}),
				}))

				const decision = await parkHandler({
					type: 'user_question',
					runId: parkRunId,
					checkpointId: `cp_question_${toolUseId}`,
					question: {
						questionId: toolUseId,
						question,
						...(header !== undefined ? { header } : {}),
						options: questionOptions,
						multiSelect,
						allowFreeText,
					},
				})

				// The no-answer sentinel (explicitly NOT consent — fixes the
				// "empty answer reads as approval" ambiguity): used for empty
				// answers, misdirected legacy decisions (e.g. a stale replica
				// resolving with approve/continue verbs), and answers that
				// carry a different question's id.
				const noAnswer = {
					success: true,
					output:
						'The user did not answer this question. Do not assume a choice or consent; proceed on your best judgment or continue without this information.',
					data: { question, answered: false },
				}

				if (decision.action === 'abort') {
					return {
						success: false,
						output:
							'The user declined to answer and asked to stop. Acknowledge briefly and end your turn.',
						data: { question, answered: false, declined: true },
					}
				}

				if (decision.action !== 'answer_question') return noAnswer
				if (decision.questionId !== undefined && decision.questionId !== toolUseId) {
					// Misdirection guard: this answer was meant for a different
					// question parked under the same run (stale client). Never
					// fabricate a selection against the wrong question.
					return noAnswer
				}

				const stripRecommended = (label: string) =>
					label.replace(/\s*\(recommended\)\s*$/i, '').trim()

				const selected = decision.selectedOptionIds
					.map((id) => questionOptions.find((opt) => opt.id === id))
					.filter((opt): opt is UserQuestionOption => opt !== undefined)
					.map((opt) => ({ id: opt.id, label: stripRecommended(opt.label) }))

				const freeText = decision.freeText?.trim() ?? ''

				if (selected.length === 0 && !freeText) return noAnswer

				let output: string
				if (selected.length > 0) {
					const joined = selected.map((s) => `"${s.label}"`).join(', ')
					output = `User answered "${question}": ${joined}`
					if (freeText) {
						output += `\nAdditional note from the user: "${freeText}"`
					}
				} else {
					output = `User answered "${question}" in their own words: "${freeText}"`
				}

				return {
					success: true,
					output,
					data: {
						question,
						selected,
						...(freeText ? { freeText } : {}),
						answered: true,
					},
				}
			},
		})
		tools.push(askUserQuestion)
	}

	return tools
}
