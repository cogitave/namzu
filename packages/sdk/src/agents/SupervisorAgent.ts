import { EMPTY_TOKEN_USAGE } from '../constants/limits.js'
import { LocalTaskGateway } from '../gateway/local.js'
import { ToolRegistry } from '../registry/tool/execute.js'
import { drainQuery } from '../runtime/query/index.js'
import type { LaunchedTaskMeta } from '../runtime/query/iteration/phases/context.js'
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
 * (cowork task 02c5cf2b): the supervisor reported "3 workers done, 40KB
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

	async run(
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
		})

		const tools = new ToolRegistry()
		if (config.tools) {
			for (const tool of config.tools.getAll()) {
				tools.register(tool, config.tools.getAvailability(tool.name))
			}
		}
		for (const tool of coordinatorToolDefs) {
			tools.register(tool)
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
