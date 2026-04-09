import { LocalTaskGateway } from '../gateway/local.js'
import { ToolRegistry } from '../registry/tool/execute.js'
import { drainQuery } from '../runtime/query/index.js'
import type { LaunchedTaskMeta } from '../runtime/query/iteration/phases/context.js'
import { buildCoordinatorTools } from '../tools/coordinator/index.js'
import type { TaskGateway } from '../types/agent/gateway.js'
import type {
	AgentInput,
	AgentMetadata,
	SupervisorAgentConfig,
	SupervisorAgentResult,
} from '../types/agent/index.js'
import type { AgentTaskContext } from '../types/agent/task.js'
import { EMPTY_TOKEN_USAGE } from '../types/common/index.js'
import type { TaskId, ThreadId } from '../types/ids/index.js'
import type { RunEventListener } from '../types/run/index.js'
import { ZERO_COST } from '../utils/cost.js'
import { AbstractAgent } from './AbstractAgent.js'

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

		if (!config.threadId) {
			throw new Error('SupervisorAgent requires threadId in config')
		}

		let gateway: TaskGateway
		if (config.gateway) {
			gateway = config.gateway
		} else if (config.agentManager) {
			const taskContext: AgentTaskContext = {
				parentRunId: runId,
				parentAgentId: this.metadata.id,
				parentAbortController: this.abortController,
				depth: 0,
				budgetTracker: {
					total: config.tokenBudget,
					remaining: config.tokenBudget,
				},
				factoryOptions: config.factoryOptions,
				threadId: config.threadId as ThreadId,
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
			allowedAgentIds: config.agentIds,
			taskStore: input.taskStore,
			runId,
			getPlanManager: () => planManagerRef,
			onTaskLaunched: (agentTaskId, meta) => {
				launchedTasks.set(agentTaskId, meta)
			},
		})

		const tools = new ToolRegistry()
		for (const tool of coordinatorToolDefs) {
			tools.register(tool)
		}

		const session = await drainQuery(
			{
				systemPrompt: config.systemPrompt,
				provider: config.provider,
				tools,
				sessionConfig: {
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
				threadId: config.threadId as ThreadId,
				runId,
				parentRunId: config.parentRunId,
				depth: config.depth,
				contextLevel: 'full',
				onContextCreated: ({ planManager }) => {
					planManagerRef = planManager
				},
				taskStore: input.taskStore,
				runtimeToolOverrides: input.runtimeToolOverrides,
				taskGateway: gateway,
				launchedTasks,
			},
			listener,
		)

		const taskHandles = gateway.listTasks()
		const taskResults = taskHandles.map((handle, index) => ({
			agentId: handle.agentId,
			result: handle.result ?? {
				runId,
				status: handle.state as 'completed' | 'failed' | 'cancelled',
				usage: { ...EMPTY_TOKEN_USAGE },
				cost: { ...ZERO_COST },
				iterations: 0,
				durationMs: Date.now() - handle.createdAt,
				messages: [],
			},
			taskIndex: index,
		}))

		const completedTasks = taskResults.filter((t) => t.result.status === 'completed').length

		return {
			runId: session.id,
			status: session.status === 'completed' ? 'completed' : 'failed',
			stopReason: session.stopReason,
			usage: session.tokenUsage,
			cost: session.costInfo,
			iterations: session.currentIteration,
			durationMs: Date.now() - startTime,
			messages: session.messages,
			result: session.result,
			lastError: session.lastError,
			taskResults,
			completedTasks,
			totalTasks: taskResults.length,
		}
	}
}
