import { z } from 'zod'
import type { CompletionInbox } from '../../gateway/completion-inbox.js'
import type { PlanManager } from '../../manager/plan/lifecycle.js'
import type { PendingAnswers, QuestionParkRecorder } from '../../runtime/query/question-park.js'
import type { AgentRuntimeContext } from '../../types/agent/base.js'
import type { TaskGateway } from '../../types/agent/gateway.js'
import type { ResumeHandler, UserQuestionOption } from '../../types/hitl/index.js'
import type { RunId, TaskId } from '../../types/ids/index.js'
import type { TaskStore } from '../../types/task/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { wrapUntrusted } from '../untrusted-envelope.js'
import { resolvePlanDependencies } from './plan-dependencies.js'

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
	 * Where a completion goes when no call is left waiting for it.
	 *
	 * These tools claim a completion the moment they hand it to the model as a
	 * `tool_result`; anything unclaimed is delivered to the transcript as a
	 * notification instead. Without an inbox the tools still work and the
	 * blocking path is unchanged — only the abandoned and background
	 * completions go unheard, which is the behaviour before this existed.
	 */
	completionInbox?: CompletionInbox

	/**
	 * HITL park channel for `ask_user_question`. The tool is registered
	 * only when BOTH `resumeHandler` and `runId` are present — without a
	 * handler there is no one to route the question to, and without a
	 * runId the park request cannot be addressed.
	 */
	resumeHandler?: ResumeHandler

	/**
	 * Makes a question park durable and visible.
	 *
	 * Without it the park exists only as a suspended `await` inside one
	 * process — nothing on disk says a human owes this run an answer, and a
	 * remote host cannot observe the question at all. Optional because a
	 * host driving the tools directly may have no checkpoint store.
	 */
	questionParks?: QuestionParkRecorder

	/**
	 * Answers carried in from a resumed run, keyed by `questionId`.
	 *
	 * Consulted BEFORE the park handler: a re-entered `ask_user_question`
	 * must return the answer that was already given rather than asking
	 * again. Without it, resuming re-parks a question the user answered —
	 * and in a headless resume that either deadlocks or auto-answers with
	 * the no-consent sentinel, discarding the real answer.
	 */
	pendingAnswers?: PendingAnswers
}

const approvePlanStepSchema = z.object({
	description: z.string().describe('What this step does'),
	agent_id: z
		.string()
		.optional()
		.describe('Which agent handles this (omit for orchestrator-owned steps)'),
	depends_on: z.array(z.string()).optional().describe('Step descriptions this depends on'),
})

/**
 * The single closed shape a capable provider constrains this call to.
 *
 * `options` arriving as a STRING is the failure this exists for: a model that
 * serializes the array once tends to keep doing it, and the parse error it
 * gets back never says the array was the problem.
 * `additionalProperties: false` turns that into a refusal at generation time
 * rather than a rejection after the fact.
 */
const askUserQuestionModelInputSchema: Record<string, unknown> = {
	type: 'object',
	properties: {
		question: {
			type: 'string',
			description: 'Full question text — clear, specific, and ending with a question mark.',
		},
		header: {
			type: 'string',
			description: 'Optional very short topic label, no more than 24 characters.',
		},
		options: {
			type: 'array',
			description: 'A JSON array of 2-4 genuinely distinct, context-derived option objects.',
			items: {
				type: 'object',
				properties: {
					label: {
						type: 'string',
						description:
							'Concise option label. Put the recommended option first and append " (Recommended)".',
					},
					description: {
						type: 'string',
						description: 'Optional one-line explanation of what changes if selected.',
					},
				},
				required: ['label'],
				additionalProperties: false,
			},
		},
		multiSelect: {
			type: 'boolean',
			description: 'True only when several options can apply at once.',
		},
		allowFreeText: {
			type: 'boolean',
			description: 'Whether the user may answer in their own words.',
		},
	},
	required: ['question', 'options'],
	additionalProperties: false,
}

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

/**
 * The delegate roster, as a closed set — including when it is empty.
 *
 * This used to be `agentIds.length > 0 ? z.enum(agentIds) : z.string()`, so
 * the one input that means "this run may delegate to nobody" became "this run
 * may name anything". An allow-list *is* the enumeration of the conditions
 * under which access is permitted; an empty one enumerates nothing and so
 * admits nothing. Degrading it to an open string instead is **failing open**
 * (CWE-636: falling back to a state less secure than the alternatives
 * available, in order to keep functioning) — and CWE-183, *Permissive List of
 * Allowed Inputs*, catalogues the limit case where the list admits something
 * unsafe. Saltzer & Schroeder named the underlying rule in 1975 as **fail-safe
 * defaults**: "the default situation is lack of access, and the protection
 * scheme identifies conditions under which access is permitted"
 * (*The Protection of Information in Computer Systems*, §I.A.3(b)). The same
 * paragraph states the asymmetry that decides it — a mechanism granting
 * explicit permission tends to fail by refusing, which is detected quickly,
 * while one enumerating refusals tends to fail by allowing, "a failure which
 * may go unnoticed in normal use".
 *
 * The primary control is that `create_task` is not mounted at all on an empty
 * roster (see the assembly at the end of this builder). This branch is
 * defence-in-depth for a definition constructed directly, and should normally
 * never render: `z.never()` renders as `{"not":{}}`, which is valid draft-07
 * but sits outside the keyword subset some strict tool-schema validators
 * accept, and a rejected tool schema fails the whole request rather than the
 * one tool. `z.enum([])` is no better — it renders an empty `enum` array,
 * equally outside some validators' subsets.
 */
function delegateSchema(agentIds: readonly string[]): z.ZodType<string> {
	if (agentIds.length === 0) {
		return z.never({
			errorMap: () => ({
				message:
					'This run has no delegates configured, so it cannot launch a task. That is the configured state, not a missing argument.',
			}),
		}) as unknown as z.ZodType<string>
	}
	return z.enum(agentIds as [string, ...string[]])
}

/**
 * How much of a finished worker's output the listing inlines per task.
 *
 * A listing is consulted when several tasks are in flight, so the whole of
 * every result would be a wall. Enough to be usable, with `wait_for_task`
 * named as the way to get the rest.
 */
const LISTED_RESULT_LIMIT = 2_000

/**
 * How long a coordinator tool may wait on a delegated agent.
 *
 * The executor's own default is two minutes, sized for a file read or a
 * test run, and its docstring says outright that a tool which legitimately
 * runs longer declares its own. This one runs an entire agent, and did not.
 *
 * Measured on real traffic: three delegated children took 4m21s, 5m58s and
 * 8m04s; all three parents timed out at 120s. The children were never
 * killed — only the parent's wait was — so the blocking path was not
 * occasionally missed, it was structurally unreachable, and the model was
 * left polling a listing because that was the only move left to it.
 *
 * An hour rather than "a bit more than eight minutes" because a generic
 * stopwatch is the wrong instrument for a child that is making progress:
 * a failure should come from what the child is doing, not from the clock
 * the parent happens to be holding. Peer runtimes agree — the ones that
 * bound a delegated child at all land on an hour, and several impose no
 * wall-clock bound whatsoever, bounding turns or depth instead.
 *
 * A wedged child is still caught, an hour later, and the run budget and
 * iteration ceiling both still apply above this.
 */
export const DELEGATION_TIMEOUT_MS = 60 * 60 * 1000

export function buildCoordinatorTools(opts: CoordinatorToolsOptions): ToolDefinition[] {
	const {
		gateway,
		allowedAgentIds: agentIds,
		taskStore,
		runId,
		getPlanManager,
		resumeHandler,
		questionParks,
		pendingAnswers,
		completionInbox,
		// `onTaskLaunched` was the entry point for the old
		// non-blocking + envelope-injection flow. create_task is now
		// blocking, so the callback is no longer wired here.
		// Intentionally not destructured to keep the unused-binding
		// lint clean; callers can still pass it for backwards
		// compatibility (Agent tool consumes it from its own path).
	} = opts
	const cwd = opts.workingDirectory
	void opts.onTaskLaunched

	const agentIdEnum = delegateSchema(agentIds)

	const createTask = defineTool({
		name: 'create_task',
		description: `Launch a task on a specialized agent. By default this BLOCKS and returns the agent's final output as this call's tool_result; pass background: true to get a task_id back immediately and receive the result later as a task notification. Available agents: ${agentIds.join(', ')}. Prefer compact assignments; for large context, write/read shared workspace files and pass filenames or references. To launch multiple tasks in parallel, call this tool multiple times in a single assistant turn — the runtime executes every tool_use block from one response concurrently and delivers all tool_results together, so 'fan out 8 specialists' is one assistant message with 8 create_task blocks. Do not race: until a worker's result reaches you, you know nothing about it — never fabricate, summarise or predict what it will say, in any form.`,
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
			background: z
				.boolean()
				.optional()
				.describe(
					'Return immediately with a task_id instead of waiting. The result arrives later as a task notification. Use this when you have other work to do meanwhile; leave it off when the next thing you do depends on this answer.',
				),
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		// See DELEGATION_TIMEOUT_MS. Ten minutes was the first attempt at
		// this and was still a guess dressed as a measurement — real
		// children were observed at 8m04s, which it would have survived by
		// under two minutes.
		timeoutMs: DELEGATION_TIMEOUT_MS,
		async execute({ agent_id, prompt, description, plan_task_id, background }, _context) {
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
				// Hang the child run off THIS tool's span, so the delegation
				// shows up inside the turn that asked for it.
				...(_context.parentSpan ? { parentSpan: _context.parentSpan } : {}),
			})

			if (background) {
				// Tell the inbox to hold the run open for this. Without it the
				// supervisor could launch a worker, answer, and settle the run
				// while the worker was still going — discarding the result the
				// launch existed to produce.
				completionInbox?.expect(handle.taskId)
				// Launched to run alongside this turn. Nothing waits on it, so
				// its completion reaches the supervisor as a notification in the
				// transcript instead — see `CompletionInbox`. Returning the id
				// here is what makes that notification correlatable, and what
				// lets `wait_for_task` and `agent_task_list` reach the output.
				return {
					success: true,
					output: `Launched ${agent_id} in the background as task ${handle.taskId}. You are not waiting on it: keep working, and its result will arrive as a task notification. To fetch it yourself, call wait_for_task with this task_id.`,
					data: {
						task_id: handle.taskId,
						agent_id,
						description,
						state: handle.state,
						plan_task_id: resolvedPlanTaskId,
						background: true,
					},
				}
			}

			// The tool returns its real result as the `tool_result` for the
			// dispatching `tool_use`. Parallel fan-out happens at the executor
			// layer: when the supervisor emits N `create_task` blocks in one
			// assistant turn, the runtime runs them together and delivers all
			// N `tool_result`s at once. No second `tool_result` for the
			// same `tool_use_id` — providers reject a duplicated id outright.
			const completed = await gateway.waitForTask(handle.taskId)

			// Whether this call is still the live path decides who delivers the
			// result. If the executor already gave up on us — its deadline
			// passed and the model was told "timed out, it may still be
			// running" — then NOT claiming is what routes this completion to the
			// transcript as a notification. Claiming it would delete the output.
			//
			// The returned value below goes nowhere: the executor won its race
			// and returned already, so this result is discarded. It is written
			// out anyway because a bare `return` here would read as an oversight,
			// and because a host reading tool outcomes off its own instrumentation
			// should find the reason rather than an empty string.
			if (_context.abortSignal?.aborted) {
				return {
					success: false,
					output: `This wait was abandoned before ${agent_id} finished; its result will arrive separately as a task notification (task ${handle.taskId}).`,
					data: { task_id: handle.taskId, agent_id, abandoned: true },
				}
			}
			completionInbox?.claim(handle.taskId)
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
				// Framed, because a delegated worker is the component MOST
				// likely to have consumed something nobody here wrote. It was
				// handed a task like "read these files and report", it ran
				// `read` and `grep` and possibly `fetch` over material the user
				// did not author, and its final text lands directly in this
				// parent's context — where the parent typically holds a broader
				// tool grant than the child that produced the text. An
				// unlabelled block there reads as the parent's own reasoning.
				//
				// This is the same treatment connector-supplied prompts already
				// get, applied to the surface that had none.
				//
				// `data.result` keeps the worker's text verbatim, so a host
				// reading the result programmatically is unaffected; only the
				// model-facing `output` is framed.
				output: wrapUntrusted(
					{
						kind: 'agent-result',
						attributes: { agent: agent_id, task: handle.taskId },
						provenance: `This is the output of the delegated agent "${agent_id}", not this agent's own work.`,
					},
					resultText,
				),
				data: {
					task_id: handle.taskId,
					agent_id,
					description,
					result: resultText,
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
		// It waits on a child exactly as create_task does, so it inherits
		// the same bound rather than the file-read default.
		timeoutMs: DELEGATION_TIMEOUT_MS,
		async execute({ task_id, message }, _context) {
			await gateway.continueTask(task_id as TaskId, message)
			// Mirror create_task's blocking pattern: await the new
			// completion and return the agent's output inline. The
			// previous non-blocking shape ('You will receive a
			// task-notification…') relied on a global
			// onTaskCompleted listener that the iteration loop
			// no longer registers (envelope path is dead).
			const completed = await gateway.waitForTask(task_id as TaskId)
			// Same reasoning as create_task: the model already has a timeout
			// for this call, so leaving the completion unclaimed is what sends
			// it to the transcript as a notification.
			if (_context.abortSignal?.aborted) {
				return {
					success: false,
					output: `This wait was abandoned before task ${task_id} finished; its result will arrive separately as a task notification.`,
					data: { task_id, abandoned: true },
				}
			}
			completionInbox?.claim(task_id as TaskId)
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

	/**
	 * Join a task already running, without sending it anything.
	 *
	 * `continue_task` blocks, but only as a side effect of sending a
	 * message — so a supervisor that merely wanted to wait had to invent
	 * something to say, and one that would not do that was left calling
	 * `agent_task_list` in a sleep loop. That polling was never the model
	 * misbehaving; it was the only move on the board.
	 */
	const waitForTaskTool = defineTool({
		name: 'wait_for_task',
		description:
			'Block until an already-running task finishes and return its output. Use this instead of listing tasks in a loop: it costs one call and no waiting turns. Give it a task_id from a background create_task or from a task notification.',
		inputSchema: z.object({
			task_id: z.string().describe('Agent task ID to wait for'),
		}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		// A tool whose entire purpose is to wait must not be cut off for
		// waiting. Same bound as the launch it is waiting on.
		timeoutMs: DELEGATION_TIMEOUT_MS,
		async execute({ task_id }, _context) {
			const known = gateway.getTask(task_id as TaskId)
			if (!known) {
				return {
					success: false,
					output: `No task ${task_id}. Call agent_task_list to see which tasks exist.`,
					data: { task_id },
				}
			}

			const completed = await gateway.waitForTask(task_id as TaskId)
			if (_context.abortSignal?.aborted) {
				return {
					success: false,
					output: `This wait was abandoned before task ${task_id} finished; its result will arrive separately as a task notification.`,
					data: { task_id, abandoned: true },
				}
			}
			completionInbox?.claim(task_id as TaskId)

			const success = completed.state === 'completed'
			const resultText =
				completed.result?.result ??
				completed.result?.lastError ??
				`Task finished with state: ${completed.state}`
			return {
				success,
				output: wrapUntrusted(
					{
						kind: 'agent-result',
						attributes: { agent: completed.agentId, task: completed.taskId },
						provenance: `This is the output of the delegated agent "${completed.agentId}", not this agent's own work.`,
					},
					resultText,
				),
				data: {
					task_id,
					agent_id: completed.agentId,
					state: completed.state,
					result: resultText,
				},
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
			// Stop holding the run open for it. `expect` put this task on the
			// inbox's outstanding list at launch and only a completion takes it
			// off — so without this a cancelled worker kept `hasPendingWork`
			// true and every attempt to settle paid the full grace period
			// waiting for a result that had just been called off.
			completionInbox?.forget(task_id as TaskId)
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
			"Inspect the live state of every agent task launched on this gateway via create_task: returns each task's id, agent, state (pending/running/completed/failed/canceled), and timing. Distinct from the plan-task store's `task_list` (which lists planning tasks): this tool lists running/completed worker invocations. Do NOT call this to find out whether work finished: a blocking create_task has already returned each worker's output, and a backgrounded one arrives as a task notification. Use it when you need to see what is still running, or to re-read the output of a task whose launch you stopped waiting for.",
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
				// The worker's actual output, which this listing used to drop. It
				// read `h.result` for the status and the error and stopped one
				// property short of the thing the task was launched to produce —
				// so a supervisor that knew a task_id and knew it had completed
				// still had no way to read what it said. That is the state a run
				// lands in whenever the launching call was abandoned, which is
				// exactly when this listing gets consulted.
				const output = h.result?.result ?? undefined
				return {
					task_id: h.taskId,
					agent_id: h.agentId,
					state: h.state,
					run_status: runStatus,
					created_at: new Date(h.createdAt).toISOString(),
					completed_at: h.completedAt ? new Date(h.completedAt).toISOString() : null,
					duration_ms: h.completedAt ? h.completedAt - h.createdAt : null,
					last_error: lastError,
					...(output !== undefined ? { result: output } : {}),
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
				? items.map((i) => {
						const head = `- ${i.task_id} → ${i.agent_id} [${i.state}${i.run_status && i.run_status !== i.state ? ` / ${i.run_status}` : ''}]${
							i.duration_ms !== null ? ` (${Math.round(i.duration_ms / 1000)}s)` : ''
						}${i.last_error ? ` — error: ${i.last_error.slice(0, 200)}` : ''}`
						// The output goes in the rendered TEXT, not only in `data`.
						// Only `output` becomes the tool_result the model reads —
						// the executor never looks at `data` — so a result added
						// to the projection alone would have been added to a field the
						// model cannot see, which is how this listing came to prove a
						// task had finished while withholding what it said.
						if (i.result === undefined) return head
						const body =
							i.result.length > LISTED_RESULT_LIMIT
								? `${i.result.slice(0, LISTED_RESULT_LIMIT)}\n    … truncated; call wait_for_task with "${i.task_id}" for the whole thing.`
								: i.result
						return `${head}\n${body
							.split('\n')
							.map((line) => `    ${line}`)
							.join('\n')}`
					})
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
	// `cancel_task` is registered again, and the reasoning that dropped it is
	// worth keeping because it was sound at the time and is not any more.
	//
	// It read: per-task cancellation belonged to the old non-blocking worker
	// protocol; since `create_task` blocks and returns the output as its
	// tool_result, every worker is terminal by the time a later turn learns its
	// id, so the tool could only manufacture a "cancelled" for something
	// already finished.
	//
	// That held for exactly as long as blocking was the only way to launch.
	// `background: true` brings back a worker that is running with nothing
	// waiting on it and whose id the supervisor holds while it is still alive —
	// the precondition the old rationale said had disappeared. A launch the
	// model cannot stop is a hole, and this is the tool that closes it.
	// An empty roster withholds `create_task` rather than mounting an
	// unsatisfiable one. Mounting it and refusing at parse time reaches the
	// same verdict, but it reaches it the expensive way: the model is shown a
	// tool every turn whose description reads "Available agents: ." and whose
	// one required parameter no value can satisfy, and it pays a turn to find
	// that out. That is the shape this codebase already criticises for
	// per-call denial — the denial is correct and the cost is prompt-prefix
	// tokens plus an iteration per attempt. Not offering the capability is
	// least functionality (NIST SP 800-53 Rev. 5 CM-7: provide only
	// mission-essential capabilities; SC-7(5) states the same rule under the
	// name "deny by default, allow by exception").
	//
	// `create_task` is the only coordinator tool that reads the roster, so the
	// withholding is exactly one tool wide. "No delegates, but still planning
	// and a human channel" stays a supported configuration, which is why this
	// omits rather than refusing to build: a caller asking this builder for
	// `ask_user_question` with no roster is doing something legitimate.
	// `wait_for_task` and `cancel_task` ride with `create_task` because they
	// are only meaningful once something has been launched.
	//
	// Waiting had no tool at all. `continue_task` blocks, but only as a side
	// effect of sending a message, so a supervisor that merely wanted to wait
	// had to invent something to say — and one that would not do that was left
	// calling `agent_task_list` in a sleep loop. That was never the model
	// misbehaving; it was the only move available.
	const tools: ToolDefinition[] =
		agentIds.length > 0 ? [createTask, waitForTaskTool, cancelTask, agentTaskList] : [agentTaskList]

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

				// Resolve BEFORE touching the plan manager. A refusal here has to
				// leave no half-built plan behind: `startGenerating` replaces the
				// current plan, so failing after it would discard a plan that was
				// fine in favour of one that never completes.
				const dependencies = resolvePlanDependencies(steps, (index) => `step_${index + 1}`)
				if (!dependencies.ok) {
					return { success: false, output: '', error: dependencies.error }
				}

				pm.startGenerating(title)
				for (let i = 0; i < steps.length; i++) {
					const step = steps[i]
					if (!step) throw new Error(`Plan step at index ${i} is undefined`)
					pm.addStep({
						id: `step_${i + 1}`,
						description: step.description,
						toolName: step.agent_id ? 'create_task' : undefined,
						// Was `[]` unconditionally, which dropped every ordering
						// constraint the model was invited to express — and put an
						// empty dependency list in front of the human approving it.
						dependsOn: [...(dependencies.dependsOn[i] ?? [])],
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
			inputSchema: z
				.object({
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
							z
								.object({
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
								})
								.strict(),
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
				})
				.strict(),
			modelInputSchema: structuredClone(askUserQuestionModelInputSchema),
			enforceModelInput: true,
			validationErrorHint:
				'Required shape: {"question":"...?","options":[{"label":"First (Recommended)","description":"What changes"},{"label":"Second","description":"What changes"}]}. "options" must be a JSON array of 2-4 objects, never a string.',
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

				const questionData = {
					questionId: toolUseId,
					question,
					...(header !== undefined ? { header } : {}),
					options: questionOptions,
					multiSelect,
					allowFreeText,
				}

				// An answer carried in from a resumed run. Checked before the
				// park, because re-entering this tool is HOW the answer gets
				// delivered: the batch is re-executed, and without this the
				// re-execution would ask the user something they already
				// answered — or, headless, auto-answer with the no-consent
				// sentinel and throw the real answer away.
				const carried = pendingAnswers?.take(toolUseId)

				// A real checkpoint, not a synthetic id nothing ever wrote.
				// Skipped when an answer is already in hand: parking a
				// question that is answered would leave an outstanding record
				// for a decision that has been made.
				const parkedAt =
					carried === undefined && questionParks ? await questionParks.record(questionData) : null

				const decision =
					carried ??
					(await parkHandler({
						type: 'user_question',
						runId: parkRunId,
						checkpointId: parkedAt ?? `cp_question_${toolUseId}`,
						question: questionData,
					}))

				// Clear the park once the answer is in, so an approval queue
				// stops serving a question that has been answered.
				if (parkedAt !== null && questionParks) {
					await questionParks.resolve(parkedAt, decision)
				}

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
