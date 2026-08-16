import { z } from 'zod'
import type { PlanManager } from '../../manager/plan/lifecycle.js'
import type { PendingAnswers, QuestionParkRecorder } from '../../runtime/query/question-park.js'
import type { CompletionInbox } from '../../scheduler/completion-inbox.js'
import type { AgentRuntimeContext } from '../../types/agent/base.js'
import type { TaskScheduler } from '../../types/agent/scheduler.js'
import type { ResumeHandler, UserQuestionOption } from '../../types/hitl/index.js'
import type { RunId, TaskId } from '../../types/ids/index.js'
import type { TaskStore } from '../../types/task/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { asCheckpointId, asTaskId } from '../../utils/id.js'
import { defineTool } from '../defineTool.js'
import { wrapUntrusted } from '../untrusted-envelope.js'
import { failureLabel, taskSucceeded } from './outcome.js'
import { resolvePlanDependencies } from './plan-dependencies.js'
import { describeWaitTimeout, waitForTaskWithBounds } from './wait-with-idle-bound.js'

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
	gateway: TaskScheduler
	workingDirectory: string
	runtimeContext?: AgentRuntimeContext
	allowedAgentIds: string[]

	/**
	 * May this run delegate at all? Defaults to true.
	 *
	 * Same field, same name, as SupervisorAgentConfig.allowDelegation — the
	 * name is kept identical deliberately. This options bag already renames
	 * agentIds to allowedAgentIds, and a second rename on the road between
	 * the config and the decision would make the road untraceable.
	 */
	allowDelegation?: boolean

	taskStore?: TaskStore

	/**
	 * Called when a plan is APPROVED, so the run can leave plan mode.
	 *
	 * A callback rather than a store handle, because what "leaving plan
	 * mode" means belongs to whoever owns the mode — a run flipping its own
	 * box, a host persisting to a topic record, both, or neither. This file
	 * knows only that approval happened.
	 */
	onPlanApproved?: () => Promise<void> | void

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

/** One well-formed tag token: `<step>`, `</step>`, `<a href="…">`, `<br/>`. */
const TAG_TOKEN = /<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>/g
const DESCRIPTION_BLOCK = /<description>([\s\S]*?)<\/description>/gi

/**
 * Remove every tag token, including the ones removing a tag creates.
 *
 * One pass is not enough and the reason is not obvious: deleting an inner
 * tag can splice its neighbours into a new one. `<<step>step>` loses the
 * inner `<step>` and the halves close up into `<step>` again, so a line
 * that is nothing but markup comes back non-empty and is offered to a
 * human as a step to approve — which is the exact outcome this whole path
 * exists to prevent.
 *
 * Repeating to a fixed point terminates: every pass that changes the
 * string removes at least one token and so strictly shortens it.
 *
 * Only ever used to ANSWER "is there anything here besides markup". The
 * result is never shown to anyone, so this is a test rather than a
 * sanitiser, and it does not have to defend against every way a tag can
 * be spelled.
 */
function withoutTags(text: string): string {
	let current = text
	for (;;) {
		const next = current.replace(TAG_TOKEN, '')
		if (next === current) return current
		current = next
	}
}

/**
 * Peel tag wrappers off the ENDS of one line, and nowhere else — a step
 * that legitimately says "wrap it in a <div>" keeps its sentence.
 */
function unwrapStepLine(line: string): string {
	let text = line.trim()
	for (;;) {
		const next = text
			.replace(/^<[A-Za-z][\w-]*(?:\s[^<>]*)?>\s*/, '')
			.replace(/\s*<\/[A-Za-z][\w-]*>$/, '')
			.trim()
		if (next === text) break
		text = next
	}
	return text
}

/**
 * A step list the model serialized instead of building.
 *
 * The line-splitting fallback below is the general case, and it had one
 * shape badly wrong. A model that serializes this array tends to reach for
 * MARKUP, not for prose:
 *
 *     <steps>
 *     <step>
 *     <description>Convert the document to Word</description>
 *     </step>
 *     </steps>
 *
 * Split on newlines, that is seven "steps", five of which are tags. A host
 * then numbered them in an approval card and asked a person to approve
 * `</steps>` — reported from a real run. The descriptions the model named
 * are right there, so read them; fall back to lines only when there are
 * none, and drop the lines that carry no words at all.
 */
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

	const described = [...trimmed.matchAll(DESCRIPTION_BLOCK)]
		.map((match) => (match[1] ?? '').trim())
		.filter(Boolean)
	if (described.length > 0) {
		return described.map((description) => ({ description }))
	}

	const lines = trimmed
		.split(/\r?\n+/)
		.map((line) =>
			unwrapStepLine(
				line
					.trim()
					.replace(/^(?:[-*•]|\d+[.)])\s*/, '')
					.trim(),
			),
		)
		.filter((line) => line.length > 0 && withoutTags(line).trim().length > 0)

	// Every line was markup: there is no plan in this string, and inventing
	// one step reading `<steps>` is worse than saying so.
	if (lines.length === 0) {
		return withoutTags(unwrapStepLine(trimmed)).trim()
			? [{ description: unwrapStepLine(trimmed) }]
			: []
	}

	return lines.map((description) => ({ description }))
}

/**
 * The single closed shape a capable provider constrains this call to —
 * the same instrument `ask_user_question` carries, for the same failure.
 *
 * `steps` arriving as a STRING is what everything above exists to survive,
 * and surviving it is not the same as preventing it: the normalizer can
 * only guess at a structure the model already threw away. Advertising the
 * closed shape turns the guess into a refusal at generation time.
 */
const approvePlanModelInputSchema: Record<string, unknown> = {
	type: 'object',
	properties: {
		title: {
			type: 'string',
			description: 'Short title for the plan (e.g. "TypeScript Security & Performance Review").',
		},
		summary: {
			type: 'string',
			description: '1-3 sentence summary of what you plan to do.',
		},
		steps: {
			type: 'array',
			description:
				'A JSON array of ordered step objects. Never a string, and never markup — no <step> or <description> tags.',
			items: {
				type: 'object',
				properties: {
					description: {
						type: 'string',
						description: 'What this step does, as one plain sentence a person can read.',
					},
					agent_id: {
						type: 'string',
						description: 'Which agent handles this; omit for steps you carry out yourself.',
					},
					depends_on: {
						type: 'array',
						items: { type: 'string' },
						description: 'Descriptions of the steps that must finish before this one.',
					},
				},
				required: ['description'],
				additionalProperties: false,
			},
		},
	},
	required: ['title', 'summary', 'steps'],
	additionalProperties: false,
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

/**
 * How long a delegated worker may say nothing before the wait gives up.
 *
 * The hour above answers "how long is too long". It cannot also answer
 * "how quiet is too quiet", because it has to be generous enough for a
 * child doing real work — which makes it useless as a stall detector. A
 * worker wedged in its second minute held the supervisor for another
 * fifty-eight under that number alone.
 *
 * Five minutes of silence, because a worker between tool calls can be
 * quiet for a while legitimately — a long model turn emits nothing until
 * it starts streaming — and the cost of guessing low is killing a wait on
 * a worker that was fine. Guessing high only delays a diagnosis. Set
 * `NAMZU_DELEGATION_IDLE_MS` to change it.
 *
 * Only armed when the gateway can report progress at all; see
 * `TaskScheduler.onTaskProgress`.
 */
export const DELEGATION_IDLE_MS = readPositiveIntEnv('NAMZU_DELEGATION_IDLE_MS', 5 * 60 * 1000)

function readPositiveIntEnv(key: string, fallback: number): number {
	const value = process.env[key]?.trim()
	if (!value) return fallback
	const parsed = Number(value)
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * The answer a delegated child produced, as the string a parent model reads.
 *
 * One function because two delegation surfaces ask the same question, and the
 * comment on the other one records what happens when a rule lives at one site
 * only: create_task shipped without the success check that agent already had.
 *
 * A schema-configured child answers with an object. Reading structuredOutput
 * first is what stops a supervisor receiving prose it then has to re-parse.
 */
function delegatedAnswer(
	result: { structuredOutput?: unknown; result?: string } | undefined,
): string | undefined {
	const structured = result?.structuredOutput
	if (structured !== undefined) {
		return typeof structured === 'string' ? structured : JSON.stringify(structured)
	}
	return result?.result
}

export function buildCoordinatorTools(opts: CoordinatorToolsOptions): ToolDefinition[] {
	const {
		gateway,
		allowedAgentIds: agentIds,
		allowDelegation,
		taskStore,
		onPlanApproved,
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

	/**
	 * The tasks THIS surface launched — the scope of everything it will read back.
	 *
	 * A `TaskScheduler` is shared on purpose: `SupervisorAgentConfig.scheduler`
	 * exists so a host can hand the same one to several runs. `listTasks()` is
	 * therefore gateway-wide by design, and `agent_task_list` used to hand that
	 * straight to the model — so a supervisor could read a sibling run's worker
	 * output, including the `result` field, by listing. `wait_for_task` had the
	 * same reach through `getTask`.
	 *
	 * That is the leak `CompletionInbox` closed on the push side, through a
	 * different door: the inbox refuses a completion for a task it was not told
	 * about, precisely because `onTaskCompleted` is a broadcast. The pull side
	 * kept no such record and asked the gateway directly.
	 *
	 * The scope lives here rather than in `listTasks()` because the two answer
	 * different questions. A host calling `listTasks()` is the operator and may
	 * legitimately want everything on its gateway; a model calling
	 * `agent_task_list` is one run asking about its own work. Narrowing the
	 * gateway method would take the operator's view away to fix the model's.
	 *
	 * Consequence worth stating: a task launched through a DIFFERENT surface on
	 * the same gateway — `buildAgentTool`, or the host itself — is not listed
	 * here. That is the same rule, not an exception to it.
	 */
	const launchedHere = new Set<TaskId>()
	void opts.onTaskLaunched

	const agentIdEnum = delegateSchema(agentIds)

	/**
	 * Whether a launch can be made with nothing waiting on it.
	 *
	 * A background launch returns a task id and promises the result "later, as
	 * a task notification". The only thing that keeps that promise is the
	 * inbox: it is what holds the run open for an outstanding worker and what
	 * puts the completion into the transcript. With no inbox the tool told the
	 * model to expect a message on a channel that does not exist — measured,
	 * and the launch itself succeeded, so nothing failed loudly either.
	 *
	 * Withheld rather than refused per call, and rather than thrown at
	 * construction. Least functionality (NIST SP 800-53 Rev. 5 CM-7: provide
	 * only mission-essential capabilities): a parameter the model is never
	 * shown costs it nothing, where a parameter it is shown and then denied
	 * costs prompt-prefix tokens plus an iteration per attempt. And a throw
	 * would break a legitimate caller — an inbox-less coordinator surface is a
	 * supported configuration whose blocking path is unaffected, pinned by a
	 * test ("runs unchanged with no inbox at all"). That is the same reasoning
	 * that made an empty roster WITHHOLD `create_task` rather than refuse to
	 * build, and it is one parameter wide here for the same reason it was one
	 * tool wide there.
	 */
	const canLaunchInBackground = completionInbox !== undefined

	const backgroundClause = canLaunchInBackground
		? " By default this BLOCKS and returns the agent's final output as this call's tool_result; pass background: true to get a task_id back immediately and receive the result later as a task notification."
		: " This BLOCKS and returns the agent's final output as this call's tool_result."

	/**
	 * What to tell the model when a wait was cut short.
	 *
	 * The worker keeps going either way — giving up on a wait is a statement
	 * about the waiter, not about the work. Where the result then turns up is
	 * NOT the same either way, and the tool said it was: it promised a task
	 * notification unconditionally, which without an inbox is a message on a
	 * channel that does not exist. A model told to expect one waits for it,
	 * and the one tool that could still reach the output is the one it was
	 * told not to use for this.
	 */
	const whereTheResultWillTurnUp = (taskId: TaskId): string =>
		completionInbox
			? `its result will arrive separately as a task notification (task ${taskId}).`
			: `it is still running as task ${taskId} — call wait_for_task with that id, or find it in agent_task_list once it finishes. Nothing will announce it on its own.`

	/**
	 * The listing's standing advice, which depends on there being an inbox.
	 *
	 * "Do not call this to find out whether work finished" is right when a
	 * notification is coming. With no inbox an abandoned blocking launch has
	 * no announcer at all, and this listing is the only way left to reach the
	 * output — so the same sentence would send the model away from the one
	 * tool that could help it.
	 */
	const listingAdvice = completionInbox
		? "Do NOT call this to find out whether work finished: a blocking create_task has already returned each worker's output, and a backgrounded one arrives as a task notification. Use it when you need to see what is still running, or to re-read the output of a task whose launch you stopped waiting for."
		: "A blocking create_task already returns each worker's output, so do not call this in a loop to find out whether work finished. Nothing announces a completion on this configuration, so this listing and wait_for_task are how you reach the output of a task whose launch you stopped waiting for."

	const createTask = defineTool({
		name: 'create_task',
		description: `Launch a task on a specialized agent.${backgroundClause} Available agents: ${agentIds.join(', ')}. Prefer compact assignments; for large context, write/read shared workspace files and pass filenames or references. To launch multiple tasks in parallel, call this tool multiple times in a single assistant turn — the runtime executes every tool_use block from one response concurrently and delivers all tool_results together, so 'fan out 8 specialists' is one assistant message with 8 create_task blocks. Do not race: until a worker's result reaches you, you know nothing about it — never fabricate, summarise or predict what it will say, in any form.`,
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
			plan_step_id: z
				.string()
				.optional()
				.describe(
					'The approve_plan step this launch carries out (e.g. "step_2"). Pass it and the step reports its own outcome — running on launch, completed or failed when the worker settles — so the plan can say how it went. Omit it only when this launch is not part of the approved plan.',
				),
			...(canLaunchInBackground
				? {
						background: z
							.boolean()
							.optional()
							.describe(
								'Return immediately with a task_id instead of waiting. The result arrives later as a task notification. Use this when you have other work to do meanwhile; leave it off when the next thing you do depends on this answer.',
							),
					}
				: {}),
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
		async execute(
			{ agent_id, prompt, description, plan_task_id, plan_step_id, background },
			_context,
		) {
			let resolvedPlanTaskId = plan_task_id

			// The binding between a plan step and the work that carries it out.
			// Without it a plan's steps had no relationship to any tool call, so
			// nothing could ever observe how a step went — which is why a plan
			// could report `failed` or stay `executing` forever but never
			// `completed`.
			const planStepId = plan_step_id
			const reportStep = (status: 'running' | 'completed' | 'failed', error?: string): void => {
				if (!planStepId) return
				getPlanManager?.()?.updateStepStatus(planStepId, status, error)
			}
			reportStep('running')

			if (taskStore) {
				if (resolvedPlanTaskId) {
					await taskStore.update(asTaskId(resolvedPlanTaskId), {
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
				// Same as the `Agent` tool: a delegate inherits the environment
				// its parent was given, or it runs against different services
				// than the run that asked for the work.
				...(Object.keys(_context.env ?? {}).length > 0
					? { configOverrides: { env: _context.env } }
					: {}),
			})

			// Whose task this is. The inbox ignores completions for anything it
			// was not told about, because `onTaskCompleted` is a broadcast and a
			// gateway shared between two supervisors would otherwise hand each
			// of them the other's worker output. Said on BOTH paths: the
			// blocking one needs it too, because the case the inbox exists for
			// is exactly the blocking launch whose wait was abandoned.
			completionInbox?.launched(handle.taskId)

			// ...and whose it is for the READ side too. See `launchedHere`.
			launchedHere.add(handle.taskId)

			// A background launch asked for with nowhere to deliver it is
			// REFUSED, not quietly turned into a blocking one.
			//
			// The schema withholds the parameter and Zod strips what it does
			// not declare, so this is unreachable through the model; it exists
			// for a directly-constructed definition. Falling back to blocking
			// would have been the tempting answer — the caller does get the
			// output — but it is accepting work whose stated terms cannot be
			// met, and the caller asked for a call that returns immediately.
			// Naming the missing piece is the only response that tells them
			// what to change.
			if (background && !canLaunchInBackground) {
				// The plan task was marked in progress a few lines above, on the
				// assumption that a worker was about to run. Nothing is running,
				// so leaving it there would show a plan step underway with no
				// worker behind it — indefinitely, since nothing later will
				// close a task whose launch never happened.
				if (resolvedPlanTaskId && taskStore) {
					await taskStore.update(asTaskId(resolvedPlanTaskId), {
						status: 'failed',
						description: 'Failed: the launch was refused before any worker started',
					})
				}
				// Same reason the plan task is closed here: nothing is running,
				// so a step left `running` would show work underway with no
				// worker behind it, and the plan could never settle.
				reportStep('failed', 'the launch was refused before any worker started')
				return {
					success: false,
					output: '',
					error:
						'background: true needs a CompletionInbox — without one there is no channel for the notification this launch promises. Pass `completionInbox` to buildCoordinatorTools and the same instance to drainQuery, or omit `background` to wait for the result inline.',
				}
			}

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
			// Bounded by two clocks rather than one. The wait gives up on a
			// worker that has gone quiet long before the hour is out, and says
			// which of the two ran out — the caller acts on that difference.
			// Giving up does NOT cancel the child: it keeps going, and its
			// result still reaches the supervisor as a notification.
			const outcome = await waitForTaskWithBounds(gateway, handle.taskId, {
				runMs: DELEGATION_TIMEOUT_MS,
				idleMs: DELEGATION_IDLE_MS,
			})
			if (outcome.kind === 'timeout') {
				return {
					success: false,
					output: describeWaitTimeout(outcome),
					data: { task_id: handle.taskId, agent_id, timed_out: outcome.cause },
				}
			}
			const completed = outcome.handle

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
					output: `This wait was abandoned before ${agent_id} finished; ${whereTheResultWillTurnUp(handle.taskId)}`,
					data: { task_id: handle.taskId, agent_id, abandoned: true },
				}
			}
			completionInbox?.claim(handle.taskId)
			// Both authorities, not just the gateway's. `finalizeChild` always
			// calls `markCompleted`, so `state === 'completed'` holds for a
			// child that ran and returned `status: 'failed'` — and this tool
			// reported that child's error text to the model as its answer, with
			// `isError: false`, while writing the plan task closed as though
			// the work had been done.
			const success = taskSucceeded(completed)
			const resultText =
				delegatedAnswer(completed.result) ??
				completed.result?.lastError ??
				`Task finished with state: ${failureLabel(completed)}`

			if (resolvedPlanTaskId && taskStore) {
				// The status carries the outcome now, rather than `completed`
				// with the failure written into prose. A reader scanning
				// statuses saw work that had been done; only a reader of every
				// description saw otherwise — and a dependent unit had no way
				// to tell at all.
				await taskStore.update(asTaskId(resolvedPlanTaskId), {
					status: success ? 'completed' : 'failed',
					description: success ? undefined : `Failed: ${resultText.substring(0, 200)}`,
				})
			}

			// The step reports the same outcome, from the same two authorities.
			// This is the only point in a delegated launch where the answer is
			// actually known.
			reportStep(success ? 'completed' : 'failed', success ? undefined : resultText.slice(0, 200))

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
			// Same scope as the listing — see `launchedHere`. Asked FIRST, so a
			// task belonging to a sibling run on a shared gateway is refused
			// here rather than waited on and then read.
			if (!launchedHere.has(task_id as TaskId)) {
				// Deliberately does not distinguish "never existed" from
				// "belongs to someone else". The second answer is itself the
				// leak in miniature: it confirms a task id a run was not
				// supposed to know about.
				return {
					success: false,
					output: `No task ${task_id} was launched by this run. Call agent_task_list to see the tasks you can wait on.`,
					data: { task_id },
				}
			}

			const known = gateway.getTask(task_id as TaskId)
			if (!known) {
				return {
					success: false,
					output: `No task ${task_id}. Call agent_task_list to see which tasks exist.`,
					data: { task_id },
				}
			}

			const outcome = await waitForTaskWithBounds(gateway, task_id as TaskId, {
				runMs: DELEGATION_TIMEOUT_MS,
				idleMs: DELEGATION_IDLE_MS,
			})
			if (outcome.kind === 'timeout') {
				return {
					success: false,
					output: describeWaitTimeout(outcome),
					data: { task_id, timed_out: outcome.cause },
				}
			}
			const completed = outcome.handle
			if (_context.abortSignal?.aborted) {
				return {
					success: false,
					output: `This wait was abandoned before task ${task_id} finished; ${whereTheResultWillTurnUp(task_id as TaskId)}`,
					data: { task_id, abandoned: true },
				}
			}
			completionInbox?.claim(task_id as TaskId)

			const success = completed.state === 'completed'
			const resultText =
				delegatedAnswer(completed.result) ??
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

	const continueTaskTool = defineTool({
		name: 'continue_task',
		description:
			"Send a further instruction to a running agent task you launched with create_task. Use it to redirect a background worker that is heading the wrong way, instead of cancelling it and losing everything it has done. Does not block: the worker's result still arrives the way it already would.",
		inputSchema: z.object({
			task_id: z.string().describe('Agent task ID from a previous create_task'),
			message: z.string().describe('The instruction to hand the worker'),
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		async execute({ task_id, message }) {
			// Same fencing as the listing and the wait — see `launchedHere`.
			// Asked FIRST, so a task belonging to a sibling run on a shared
			// gateway is refused before anything is delivered to it.
			if (!launchedHere.has(task_id as TaskId)) {
				// Does not distinguish "never existed" from "belongs to someone
				// else", for the reason `wait_for_task` gives: the second answer
				// confirms a task id this run was not supposed to know.
				return {
					success: false,
					output: `No task ${task_id} was launched by this run. Call agent_task_list to see the tasks you can steer.`,
					data: { task_id },
				}
			}

			const known = gateway.getTask(task_id as TaskId)
			if (!known) {
				return {
					success: false,
					output: `Task ${task_id} is no longer tracked, so there is nothing to send it.`,
					data: { task_id },
				}
			}

			try {
				await gateway.continueTask(task_id as TaskId, message)
			} catch (err) {
				// The manager refuses a terminal task by throwing, and a throw
				// out of `execute` is a tool ERROR — which reads to the model as
				// "the platform broke" rather than "that worker has finished".
				// Named as a refusal with the state in it, so the next move is
				// obvious: read its result instead of steering it.
				return {
					success: false,
					output: `Could not send to task ${task_id} (state: ${known.state}): ${toErrorMessage(err)}`,
					data: { task_id, state: known.state },
				}
			}

			// Deliberately does not wait. The worker's result arrives the way it
			// already would — as this call's `tool_result` for a blocking
			// launch, or as a completion notification for a background one — and
			// blocking here would turn a redirect into a second `wait_for_task`
			// the supervisor did not ask for.
			return {
				success: true,
				output: `Sent to task ${task_id}. It will see this at its next turn; its result still arrives the way it already would.`,
				data: { task_id },
			}
		},
	})

	const agentTaskList = defineTool({
		name: 'agent_task_list',
		description: `Inspect the live state of the agent tasks YOU launched with create_task: returns each task's id, agent, state (pending/running/completed/failed/canceled), and timing. Tasks launched by another run are not listed, even when it shares this gateway. Distinct from the plan-task store's \`task_list\` (which lists planning tasks): this tool lists running/completed worker invocations. ${listingAdvice}`,
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
			// Scoped to this run's own launches — see `launchedHere`. The
			// gateway may hold a sibling run's tasks, and this listing is not
			// the door to them.
			const handles = gateway.listTasks().filter((h) => launchedHere.has(h.taskId))
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
						const overLimit = i.result.length > LISTED_RESULT_LIMIT
						// Framed exactly as the blocking `create_task` and
						// `wait_for_task` frame the same bytes. This listing was the
						// third way to read a delegate's output and the only one that
						// pasted it bare — so a worker's text was material on two
						// paths and read as the parent's own reasoning on the third,
						// and which one a run got depended on how the model chose to
						// fetch it.
						const framed = wrapUntrusted(
							{
								kind: 'agent-result',
								attributes: { agent: i.agent_id, task: i.task_id },
								provenance: `This is the output of the delegated agent "${i.agent_id}", not this agent's own work.`,
							},
							overLimit ? i.result.slice(0, LISTED_RESULT_LIMIT) : i.result,
						)
						// After the closing tag, not inside it: this sentence is the
						// kernel telling the model how to get the rest, and inside
						// the envelope it has just been told the contents are not
						// instructions addressed to it.
						const body = overLimit
							? `${framed}\n… truncated; call wait_for_task with "${i.task_id}" for the whole thing.`
							: framed
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

	// `continue_task` is registered again, and the reasoning that dropped it
	// is kept because it was correct and has expired rather than been wrong.
	//
	// It read: on a LIVE task the manager accepts the call and pushes onto
	// `pendingMessages`, and NOTHING drains that queue during a run — so the
	// tool had no state it worked in. Terminal tasks refused it; live ones
	// accepted it into a queue nobody read. Registering it would have handed
	// the model a call that silently does nothing, which is worse than an
	// unregistered definition, because a tool that cannot be called at least
	// cannot fail quietly.
	//
	// The comment named its own expiry condition: "if follow-ups on a live
	// worker are wanted, the work is a consumer for the queue". That consumer
	// exists — `BaseAgentConfig.inboundMessages`, drained at the iteration
	// boundary — so the precondition the tool needed is met and the argument
	// against it no longer holds.
	//
	// A supervisor whose background worker is heading the wrong way could
	// previously only wait for it or kill it, and killing it throws away
	// everything it has done.

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
	// Two independent reasons not to mount the delegation surface, and the
	// second one is not derivable from the first.
	//
	// An empty roster answers WHO may be called: nobody, so the tools have
	// nothing to act on. `allowDelegation: false` answers WHETHER this run may
	// call anyone, which a non-empty roster cannot settle — a host that runs a
	// specialist by putting its persona into the supervisor shell and its id
	// into the roster has a list of one and must still delegate to nobody.
	// From inside this function that run is indistinguishable from a
	// supervisor whose roster happens to hold a single specialist, so the
	// caller states the fact rather than the SDK guessing it.
	//
	// `!== false` rather than truthiness, so an absent flag keeps today's
	// behaviour exactly.
	const canDelegate = agentIds.length > 0 && allowDelegation !== false
	const tools: ToolDefinition[] = canDelegate
		? [createTask, waitForTaskTool, continueTaskTool, cancelTask, agentTaskList]
		: [agentTaskList]

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
			modelInputSchema: structuredClone(approvePlanModelInputSchema),
			enforceModelInput: true,
			validationErrorHint:
				'Required shape: {"title":"…","summary":"…","steps":[{"description":"One plain sentence"}]}. "steps" must be a JSON array of objects — never a string, and never markup such as <step> or <description>.',
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

				// The roster, checked here rather than in the schema, and BEFORE
				// the plan is built — so a human is never shown a step naming an
				// agent that cannot run it.
				//
				// `create_task` constrains the same field with a closed enum, so
				// a plan could name an agent the launch would then refuse. The
				// mismatch used to be invisible because the name was dropped on
				// the way to the approver; now that a step carries it, an
				// approver could read "delegate to X" for an X that does not
				// exist.
				//
				// NOT closed in the schema, deliberately. `approve_plan` is
				// mounted even with an empty roster — planning with no delegates
				// and a human channel is a supported configuration — and
				// `z.enum([])` renders as `{"not":{}}`, the shape `delegateSchema`
				// already refuses because a strict tool-schema validator rejects
				// the whole request over it rather than the one tool.
				// `create_task` escapes that by being withheld entirely; this
				// tool cannot be.
				//
				// Enforcing in `execute` as well as the schema is the precedent
				// the canonical `Agent` tool set for complete mediation.
				const unknownAgents = [
					...new Set(
						steps
							.map((s) => s.agent_id)
							.filter((id): id is string => Boolean(id) && !agentIds.includes(id as string)),
					),
				]
				if (unknownAgents.length > 0) {
					return {
						success: false,
						output: '',
						error:
							agentIds.length === 0
								? `This plan delegates to ${unknownAgents.join(', ')}, but this run has no delegates. Plan the work as your own steps and omit agent_id.`
								: `No such agent: ${unknownAgents.join(', ')}. Delegate only to ${agentIds.join(', ')}, or omit agent_id for a step you carry out yourself.`,
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
						// WHICH agent, not just whether there is one. The schema
						// asks the model to name an agent per step and the answer
						// was collapsed to the boolean above, so the human
						// approving the plan saw that a step delegates and never
						// to whom — at the one moment the difference can still be
						// acted on.
						...(step.agent_id ? { agentId: step.agent_id } : {}),
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

					// The step ids, because nothing else tells the model what
					// they are. `plan_step_id` on create_task and `step_id` on
					// update_plan_step are both unusable without them — a
					// binding the caller cannot name is a binding that does not
					// exist. Rendered from the plan as approved, so a plan the
					// user edited lists the steps they actually approved.
					const roster = (pm.active?.steps ?? [])
						.map((s) => `  ${s.id} — ${s.description}${s.agentId ? ` (${s.agentId})` : ''}`)
						.join('\n')
					const howToReport = roster
						? `\nSteps, and how each reports its outcome:\n${roster}\nPass plan_step_id to create_task for a delegated step; call update_plan_step for one you do yourself. The plan cannot report success until every step has reported.`
						: ''

					// Approve-with-edits: when the user attached feedback to an
					// approval, embed it in the model-visible output so the
					// supervisor applies the edits during execution.
					const output = response.feedback
						? `Plan approved by user with required edits — apply them during execution:\n${response.feedback}\nProceed with execution — launch workers via create_task.${howToReport}`
						: `Plan approved by user. Proceed with execution — launch workers via create_task.${howToReport}`
					// An approved plan LEAVES plan mode, in this conversation and
					// durably. That flow — look around under plan mode, propose,
					// get approval, continue in the SAME run — is what the mode's
					// per-run lifetime made impossible: leaving it meant ending
					// the run and discarding the step and tool-schema context.
					//
					// Failures are swallowed with a log rather than turning an
					// approval into a refusal. The user said yes; a state store
					// that cannot record it is an operator's problem to see in the
					// logs, not a reason to tell the model its approved plan was
					// rejected.
					await onPlanApproved?.()

					return {
						success: true,
						output,
						data: {
							approved: true,
							feedback: response.feedback,
							steps: (pm.active?.steps ?? []).map((s) => ({
								step_id: s.id,
								description: s.description,
								agent_id: s.agentId,
							})),
						},
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

		/**
		 * How a step the ORCHESTRATOR did reports its own outcome.
		 *
		 * `create_task` reports the steps it carries out, which covers every
		 * delegated step. A step with no `agent_id` is the orchestrator's own
		 * work and has no tool call to bind to — so without this there is no
		 * way for it to ever report, and a plan containing one could never
		 * settle no matter how well it went.
		 *
		 * `skipped` is a first-class outcome and not a euphemism for failure:
		 * a plan that turned out not to need a step went right, and forcing
		 * that into `completed` or `failed` would make the plan lie in one
		 * direction or the other.
		 */
		const updatePlanStep = defineTool({
			name: 'update_plan_step',
			description:
				'Report how a step of the approved plan went. Use it for steps YOU carried out — steps delegated with create_task report themselves when you pass plan_step_id. Call it as each step settles, not in a batch at the end: the plan cannot say it succeeded until every step has reported, and an unreported step is not scored as a failure, it simply leaves the plan unsettled. Use "skipped" for a step that turned out not to be needed; that is a successful outcome, not a failure.',
			inputSchema: z.object({
				step_id: z.string().describe('The plan step id, e.g. "step_2".'),
				status: z
					.enum(['completed', 'skipped', 'failed'])
					.describe(
						'How it went. "skipped" means the step was not needed and the plan is still on track.',
					),
				error: z
					.string()
					.optional()
					.describe('What went wrong. Only meaningful with status "failed".'),
			}),
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: true,
			async execute({ step_id, status, error }) {
				const pm = getPlanManager?.()
				if (!pm?.active) {
					return {
						success: false,
						output: '',
						error: 'There is no active plan to report against. Call approve_plan first.',
					}
				}

				const step = pm.updateStepStatus(step_id, status, error)
				if (!step) {
					const known = pm.active.steps.map((s) => s.id).join(', ')
					return {
						success: false,
						output: '',
						error: `No plan step "${step_id}". This plan's steps are: ${known || '(none)'}.`,
					}
				}

				const outstanding = pm.unreportedSteps
				return {
					success: true,
					output:
						outstanding.length === 0
							? `Step ${step_id} reported as ${status}. Every step has now reported.`
							: `Step ${step_id} reported as ${status}. Still unreported: ${outstanding
									.map((s) => s.id)
									.join(', ')}.`,
					data: { step_id, status, unreported: outstanding.map((s) => s.id) },
				}
			},
		})
		tools.push(updatePlanStep)
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
						checkpointId: parkedAt ?? asCheckpointId(`cp_question_${toolUseId}`),
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
