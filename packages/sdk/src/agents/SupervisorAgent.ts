import { EMPTY_TOKEN_USAGE } from '../constants/limits.js'
import { LocalTaskGateway } from '../gateway/local.js'
import { ToolNameCollisionError, ToolRegistry } from '../registry/tool/execute.js'
import { drainQuery } from '../runtime/query/index.js'
import type { LaunchedTaskMeta } from '../runtime/query/iteration/phases/context.js'
import { PendingAnswers, QuestionParkBinding } from '../runtime/query/question-park.js'
import { buildCoordinatorTools } from '../tools/coordinator/index.js'
import type { TaskGateway, TaskHandle } from '../types/agent/gateway.js'
import type {
	AgentInput,
	AgentMetadata,
	AgentTaskResult,
	SupervisorAgentConfig,
	SupervisorAgentResult,
} from '../types/agent/index.js'
import type { AgentTaskContext } from '../types/agent/task.js'
import type { AgentId, RunId, TaskId } from '../types/ids/index.js'
import { deriveChildState } from '../types/invocation/index.js'
import type { RunEventListener } from '../types/run/index.js'
import type { ActorRef } from '../types/session/actor.js'
import { ZERO_COST } from '../utils/cost.js'
import { AbstractAgent } from './AbstractAgent.js'

/**
 * Build the authoritative per-task ledger from the gateway's task handles.
 *
 * A handle carries a `result` only when its worker actually produced one. A
 * handle with NO result never produced a verifiable outcome, so it MUST NOT be
 * synthesized as a success: the synthesized status is always the terminal
 * `'failed'`, regardless of the handle's reported `state` (which may itself be
 * `'completed'`).
 *
 * The earlier implementation cast `handle.state` onto the synthesized result's
 * status, letting a worker that ended without a result count toward
 * `completedTasks`. That produced fabricated "done" workers with empty outputs
 * (observed in a live supervised run): the supervisor reported "3 workers done, 40KB
 * reports" when the workers never started. Real workers (those with a present
 * `result`) are unaffected — their `result` is preserved verbatim.
 */
export function synthesizeTaskResults(
	taskHandles: readonly TaskHandle[],
	runId: RunId,
	now: number = Date.now(),
): AgentTaskResult[] {
	return taskHandles.map((handle, index) => ({
		agentId: handle.agentId,
		result: handle.result ?? {
			runId,
			status: 'failed' as const,
			usage: { ...EMPTY_TOKEN_USAGE },
			cost: { ...ZERO_COST },
			iterations: 0,
			durationMs: now - handle.createdAt,
			messages: [],
		},
		taskIndex: index,
	}))
}

/** Count only the task results that genuinely completed. */
export function countCompletedTasks(taskResults: readonly AgentTaskResult[]): number {
	return taskResults.filter((t) => t.result.status === 'completed').length
}

export class SupervisorAgent extends AbstractAgent<SupervisorAgentConfig, SupervisorAgentResult> {
	readonly type = 'supervisor' as const

	constructor(metadata: Omit<AgentMetadata, 'type' | 'capabilities'>) {
		super({
			...metadata,
			type: 'supervisor',
			capabilities: {
				supportsTools: true,
				supportsStreaming: true,
				supportsConcurrency: true,
				supportsSubAgents: true,
			},
		})
	}

	/**
	 * One run at a time per instance.
	 *
	 * `abortController` and `currentRunId` are instance state, so two
	 * overlapping runs share one abort controller — cancelling either kills
	 * both — and the second clobbers the first's run id, so a later
	 * `cancel()` cancels the wrong run. Neither failure announces itself.
	 * A host that wants parallelism constructs a second instance.
	 */
	async run(
		input: AgentInput,
		config: SupervisorAgentConfig,
		listener?: RunEventListener,
	): Promise<SupervisorAgentResult> {
		return await this.underIdempotencyKey(config.idempotencyKey, () =>
			this.underInvocationLock(() => this.runExclusive(input, config, listener)),
		)
	}

	private async runExclusive(
		input: AgentInput,
		config: SupervisorAgentConfig,
		listener?: RunEventListener,
	): Promise<SupervisorAgentResult> {
		const startTime = Date.now()
		const runId = this.createRunId()

		if (!config.sessionId || !config.threadId || !config.projectId || !config.tenantId) {
			throw new Error(
				'SupervisorAgent requires sessionId, threadId, projectId, and tenantId in config (session-hierarchy.md §12.1).',
			)
		}
		const sessionId = config.sessionId
		const threadId = config.threadId
		const projectId = config.projectId
		const tenantId = config.tenantId

		const parentActor: ActorRef = {
			kind: 'agent',
			agentId: this.metadata.id as AgentId,
			tenantId,
		}

		let gateway: TaskGateway
		if (config.gateway) {
			gateway = config.gateway
		} else if (config.agentManager) {
			const mergedFactoryOptions = config.factoryOptions
				? {
						...config.factoryOptions,
						taskRouter: config.taskRouter ?? config.factoryOptions.taskRouter,
					}
				: config.taskRouter
					? ({
							taskRouter: config.taskRouter,
						} as import('../types/agent/index.js').AgentFactoryOptions)
					: undefined

			const taskContext: AgentTaskContext = {
				parentRunId: runId,
				parentAgentId: this.metadata.id,
				parentAbortController: this.abortController,
				depth: 0,
				budgetTracker: {
					total: config.tokenBudget,
					remaining: config.tokenBudget,
				},
				factoryOptions: mergedFactoryOptions,
				// The supervisor already hands this to its OWN run and its own
				// coordinator tools; handing it to the spawn context is what
				// makes a worker ask the same person the supervisor asks.
				// Without it the two disagreed: the supervisor paused for a
				// human and the workers it launched approved themselves.
				...(config.resumeHandler ? { resumeHandler: config.resumeHandler } : {}),
				tenantId,
				threadId,
				sessionId,
				projectId,
				parentActor,
			}
			gateway = new LocalTaskGateway(config.agentManager, taskContext, listener, input)
		} else {
			throw new Error("SupervisorAgentConfig requires either 'gateway' or 'agentManager'")
		}

		const launchedTasks = new Map<TaskId, LaunchedTaskMeta>()

		let planManagerRef: import('../manager/plan/lifecycle.js').PlanManager | undefined

		// Created here because the TOOLS are created here: the durability
		// channel has to reach the tool instance, and the run that supplies
		// it does not exist yet. `query` binds them once it does.
		const questionParks = new QuestionParkBinding()
		const pendingAnswers = new PendingAnswers()

		const coordinatorToolDefs = buildCoordinatorTools({
			gateway,
			workingDirectory: input.workingDirectory,
			runtimeContext: input.runtimeContext,
			allowedAgentIds: config.agentIds,
			taskStore: input.taskStore,
			runId,
			getPlanManager: () => planManagerRef,
			onTaskLaunched: (agentTaskId, meta) => {
				launchedTasks.set(agentTaskId, meta)
			},
			// With a resume handler present the coordinator surface gains
			// ask_user_question — the model can park the run on a question
			// routed through the same HITL channel as plan approvals.
			...(config.resumeHandler ? { resumeHandler: config.resumeHandler } : {}),
			questionParks,
			pendingAnswers,
		})

		const tools = new ToolRegistry()
		if (config.tools) {
			for (const tool of config.tools.getAll()) {
				tools.register(tool, config.tools.getAvailability(tool.name))
			}
		}
		// Registered the way every other kernel-mounted tool in this SDK is
		// registered: honouring `runtimeToolOverrides`, and refusing to take a
		// name the host already used.
		//
		// Both halves were missing here and nowhere else. `runtimeToolOverrides`
		// is declared on `AgentInput`, is forwarded into this very `drainQuery`
		// call below, and is consulted for the task tools and for the advisory
		// tools — but the coordinator tools were registered before that and
		// unconditionally, so `{ create_task: 'disabled' }` was honoured
		// everywhere except the one surface a host would most want to decline.
		// A run that must not delegate had prompt text and a gateway refusal as
		// its only defences.
		//
		// Collision REFUSES rather than overwrites, and the principle is
		// complete mediation rather than fail-safe defaults: "proposals to gain
		// performance by remembering the result of an authority check [must] be
		// examined skeptically. If a change in authority occurs, such remembered
		// results must be systematically updated" (Saltzer & Schroeder 1975,
		// §I.A.3(c)). A registry entry is a remembered binding of a name to an
		// authority, and a later write that rebinds the name leaves every
		// decision made about the old binding stale.
		//
		// The counter-argument is that today the host's tool merely loses
		// quietly and the run still works, so six reserved names is a real cost
		// on a name a consumer may have chosen long ago. It does not hold,
		// because "loses quietly" is not what happens. `registerOne` ends with
		// `availability.set(id, state)` and this call passes no state, so a tool
		// the host registered `deferred` or `suspended` is silently PROMOTED to
		// active under someone else's implementation; and because the store is a
		// Map, the replacement inherits the host's insertion position in the
		// prompt-cache prefix. That is a different authorization surface, not a
		// lost registration. CWE-390 is the shape `ManagedRegistry` has here —
		// detection of an error condition without action — and CWE-694's own
		// mitigation is nearly this fix: do not operate any resource with a
		// non-unique identifier, and report the error.
		//
		// Refusing is also what the peer set does. One runtime's registry
		// primitive throws on both duplicate and reserved names; another refuses
		// its injected delegation name in a pre-flight that tells the author to
		// rename. Closer to home, `ProviderRegistry.register` already throws
		// unless the caller passes `{ replace: true }` — declared intent is what
		// separates a legitimate replacement from an accidental one, and no such
		// intent is expressible here.
		const overrides = input.runtimeToolOverrides
		for (const tool of coordinatorToolDefs) {
			const override = overrides?.[tool.name]
			if (override === 'disabled') continue
			if (config.tools?.has(tool.name)) {
				throw new ToolNameCollisionError(tool.name, 'the supervisor coordinator surface')
			}
			tools.register(tool, override ?? 'active')
		}

		const childInvocationState = deriveChildState(
			config.invocationState ?? { tenantId },
			this.metadata.id,
		)

		const run = await drainQuery(
			{
				systemPrompt: config.systemPrompt,
				skills: config.skills,
				provider: config.provider,
				tools,
				runConfig: {
					model: config.model,
					tokenBudget: config.tokenBudget,
					timeoutMs: config.timeoutMs,
					maxIterations: config.maxIterations,
					temperature: config.temperature,
					env: config.env,
				},
				questionParks,
				pendingAnswers,
				agentId: this.metadata.id,
				agentName: this.metadata.name,
				workingDirectory: input.workingDirectory,
				messages: input.messages,
				signal: input.signal,
				sessionId,
				threadId,
				projectId,
				tenantId,
				runId,
				parentRunId: config.parentRunId,
				depth: config.depth,
				contextLevel: 'full',
				onContextCreated: ({ planManager }) => {
					planManagerRef = planManager
				},
				taskStore: input.taskStore,
				runtimeToolOverrides: input.runtimeToolOverrides,
				runtimeContext: input.runtimeContext,
				taskGateway: gateway,
				launchedTasks,
				advisory: config.advisory,
				invocationState: childInvocationState,
				// HITL surface: forward optional review-time hooks so hosts can
				// run "Ask before acting" supervisors instead of the default
				// auto-approve. drainQuery falls back to autoApproveHandler
				// when resumeHandler is omitted (= same behaviour as before).
				...(config.resumeHandler ? { resumeHandler: config.resumeHandler } : {}),
				// Forwarded for the same reason the handler is. A capability the
				// kernel honours in `drainQuery` but that never reaches the
				// surface a host actually constructs is a capability nobody can
				// use — which is the shape of defect this file has already been
				// corrected for twice.
				...(config.steering ? { steering: config.steering } : {}),
				...(config.verificationGate ? { verificationGate: config.verificationGate } : {}),
				...(config.sandboxProvider ? { sandboxProvider: config.sandboxProvider } : {}),
				// Working-memory / compaction seam (optional; absent => unchanged
				// run path, byte-identical for every existing consumer).
				...(config.compactionConfig ? { compactionConfig: config.compactionConfig } : {}),
				...(config.workingMemoryProvider
					? { workingMemoryProvider: config.workingMemoryProvider }
					: {}),
			},
			listener,
		)

		const taskHandles = gateway.listTasks()
		const taskResults = synthesizeTaskResults(taskHandles, runId)

		const completedTasks = countCompletedTasks(taskResults)

		return {
			runId: run.id,
			status: run.status === 'completed' ? 'completed' : 'failed',
			stopReason: run.stopReason,
			usage: run.tokenUsage,
			cost: run.costInfo,
			iterations: run.currentIteration,
			durationMs: Date.now() - startTime,
			messages: run.messages,
			result: run.result,
			lastError: run.lastError,
			taskResults,
			completedTasks,
			totalTasks: taskResults.length,
		}
	}
}
