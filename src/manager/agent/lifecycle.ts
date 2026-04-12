import { AGENT_MANAGER_DEFAULTS } from '../../constants/agent/index.js'
import { EMPTY_TOKEN_USAGE } from '../../constants/limits.js'
import type { AgentRegistry } from '../../registry/agent/definitions.js'
import type { BaseAgentConfig, BaseAgentResult } from '../../types/agent/base.js'
import type {
	AgentLifecycleEvent,
	AgentLifecycleListener,
} from '../../types/agent/lifecycle-event.js'
import type {
	AgentManagerConfig,
	AgentTask,
	AgentTaskContext,
	AgentTaskState,
	SendMessageOptions,
} from '../../types/agent/task.js'
import { isTerminalAgentTaskState } from '../../types/agent/task.js'
import type { RunId, TaskId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import { createChildAbortController } from '../../utils/abort.js'
import { ZERO_COST } from '../../utils/cost.js'
import { toErrorMessage } from '../../utils/error.js'
import { generateTaskId } from '../../utils/id.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'

export class AgentManager {
	private registry: AgentRegistry
	private instances: Map<TaskId, AgentTask> = new Map()
	private completionCallbacks: Map<TaskId, Array<() => void>> = new Map()
	private listeners: AgentLifecycleListener[] = []
	private log: Logger
	private config: Readonly<AgentManagerConfig>
	private evictionTimers: Map<TaskId, ReturnType<typeof setTimeout>> = new Map()

	constructor(registry: AgentRegistry, config?: Partial<AgentManagerConfig>) {
		this.registry = registry
		this.config = { ...AGENT_MANAGER_DEFAULTS, ...config }
		this.log = getRootLogger().child({ component: 'AgentManager' })
	}

	async sendMessage(
		options: SendMessageOptions,
		context: AgentTaskContext,
		listener?: import('../../types/run/events.js').RunEventListener,
	): Promise<AgentTask> {
		if (context.depth >= this.config.maxDepth) {
			throw new Error(
				`Max task depth ${this.config.maxDepth} exceeded (current: ${context.depth}). Recursive agent delegation is limited to prevent resource exhaustion.`,
			)
		}

		const agent = this.registry.resolve(options.agentId)

		const childAbortController = createChildAbortController(context.parentAbortController)

		const maxAllocation = Math.floor(
			context.budgetTracker.remaining * this.config.maxBudgetFraction,
		)
		const allocatedTokens = Math.min(
			options.budgetAllocation?.tokenBudget ?? maxAllocation,
			maxAllocation,
		)
		context.budgetTracker.remaining -= allocatedTokens

		const taskId = generateTaskId()
		const agentTask: AgentTask = {
			taskId,
			agentId: options.agentId,
			agent,
			childAbortController,
			context,
			state: 'pending',
			pendingMessages: [],
			createdAt: Date.now(),
			runEventListener: listener,
		}

		this.instances.set(taskId, agentTask)
		this.emit({
			type: 'pending',
			taskId,
			agentId: options.agentId,
			parentAgentId: context.parentAgentId,
			depth: context.depth,
		})

		if (listener) {
			listener({
				type: 'agent_pending',
				runId: context.parentRunId,
				taskId,
				parentAgentId: context.parentAgentId,
				childAgentId: options.agentId,
				depth: context.depth,
			})
		}
		this.log.info(`Agent task pending: ${taskId} (${options.agentId}, depth=${context.depth})`)

		const definition = this.registry.getOrThrow(options.agentId)
		let childConfig: BaseAgentConfig
		if (definition.configBuilder && context.factoryOptions) {
			childConfig = await definition.configBuilder({
				...context.factoryOptions,
				tokenBudget: allocatedTokens,
				timeoutMs: options.budgetAllocation?.timeoutMs ?? context.budgetTracker.remaining,
				threadId: context.threadId as string | undefined,
				parentRunId: context.parentRunId as string | undefined,
				depth: context.depth + 1,
				...options.configOverrides,
			})

			if (!childConfig.contextLevel && definition.contextLevel) {
				childConfig.contextLevel = definition.contextLevel
			}
		} else {
			this.log.warn('No configBuilder or factoryOptions, using bare config', {
				agentId: options.agentId,
			})
			childConfig = {
				model: options.configOverrides?.model ?? 'default',
				tokenBudget: allocatedTokens,
				timeoutMs: options.budgetAllocation?.timeoutMs ?? context.budgetTracker.remaining,
				temperature: options.configOverrides?.temperature,
				maxIterations: options.configOverrides?.maxIterations,
				maxResponseTokens: options.configOverrides?.maxResponseTokens,
				env: options.configOverrides?.env,
				threadId: context.threadId,
				parentRunId: context.parentRunId,
				depth: context.depth + 1,
			}
		}

		this.runChild(agentTask, options, childConfig, listener).catch((err) => {
			this.markFailed(taskId, toErrorMessage(err))
		})

		return agentTask
	}

	cancel(taskId: TaskId): void {
		const agentTask = this.instances.get(taskId)
		if (!agentTask || isTerminalAgentTaskState(agentTask.state)) return

		agentTask.childAbortController.abort('canceled')
		this.markCanceled(taskId)
	}

	cancelAll(parentRunId: RunId): void {
		for (const agentTask of this.listByParent(parentRunId)) {
			this.cancel(agentTask.taskId)
		}
	}

	async continueTask(taskId: TaskId, message: string): Promise<void> {
		const agentTask = this.requireInstance(taskId)
		if (isTerminalAgentTaskState(agentTask.state)) {
			throw new Error(`Cannot continue terminal task: ${taskId} (state: ${agentTask.state})`)
		}
		agentTask.pendingMessages.push({
			role: 'user' as const,
			content: message,
		} as Message)
		this.log.info(`Message queued for task ${taskId} via continueTask`)
	}

	queueMessage(taskId: TaskId, message: Message): void {
		const agentTask = this.requireInstance(taskId)
		agentTask.pendingMessages.push(message)
	}

	drainMessages(taskId: TaskId): Message[] {
		const agentTask = this.requireInstance(taskId)
		const messages = [...agentTask.pendingMessages]
		agentTask.pendingMessages.length = 0
		return messages
	}

	waitForCompletion(taskId: TaskId): Promise<void> {
		const agentTask = this.instances.get(taskId)
		if (!agentTask) {
			return Promise.reject(new Error(`Agent task not found: "${taskId}"`))
		}
		if (isTerminalAgentTaskState(agentTask.state)) {
			return Promise.resolve()
		}
		return new Promise<void>((resolve) => {
			const existing = this.completionCallbacks.get(taskId) ?? []
			existing.push(resolve)
			this.completionCallbacks.set(taskId, existing)
		})
	}

	getInstance(taskId: TaskId): AgentTask | undefined {
		return this.instances.get(taskId)
	}

	listByParent(parentRunId: RunId): AgentTask[] {
		return Array.from(this.instances.values()).filter((t) => t.context.parentRunId === parentRunId)
	}

	listActive(): AgentTask[] {
		return Array.from(this.instances.values()).filter((t) => !isTerminalAgentTaskState(t.state))
	}

	getState(taskId: TaskId): AgentTaskState | undefined {
		return this.instances.get(taskId)?.state
	}

	getRegistry(): AgentRegistry {
		return this.registry
	}

	on(listener: AgentLifecycleListener): void {
		this.listeners.push(listener)
	}

	off(listener: AgentLifecycleListener): void {
		const index = this.listeners.indexOf(listener)
		if (index >= 0) this.listeners.splice(index, 1)
	}

	cleanup(): void {
		for (const [taskId, agentTask] of this.instances) {
			if (isTerminalAgentTaskState(agentTask.state)) {
				this.clearEvictionTimer(taskId)
				this.instances.delete(taskId)
			}
		}
	}

	dispose(): void {
		for (const taskId of this.instances.keys()) {
			this.clearEvictionTimer(taskId)
		}
		this.cancelAll('' as RunId)
		this.instances.clear()
		this.listeners.length = 0
	}

	private async runChild(
		agentTask: AgentTask,
		options: SendMessageOptions,
		childConfig: BaseAgentConfig,
		listener?: import('../../types/run/events.js').RunEventListener,
	): Promise<void> {
		this.updateState(agentTask.taskId, 'running')
		this.emit({ type: 'running', taskId: agentTask.taskId })

		const input = {
			...options.input,
			signal: agentTask.childAbortController.signal,
		}

		const childListener = listener
			? async (event: import('../../types/run/events.js').RunEvent): Promise<void> => {
					const annotated = Object.assign({}, event, {
						sourceAgentId: agentTask.agentId,
						parentTaskId: agentTask.taskId,
					})
					await listener(annotated as import('../../types/run/events.js').RunEvent)
				}
			: undefined

		const result = await agentTask.agent.run(input, childConfig, childListener)
		this.markCompleted(agentTask.taskId, result)
	}

	private markCompleted(taskId: TaskId, result: BaseAgentResult): void {
		const agentTask = this.instances.get(taskId)
		if (!agentTask || isTerminalAgentTaskState(agentTask.state)) return

		agentTask.result = result
		agentTask.completedAt = Date.now()
		this.updateState(taskId, 'completed')
		this.emit({ type: 'completed', taskId, result })
		this.emitRunEvent(agentTask, {
			type: 'agent_completed',
			runId: agentTask.context.parentRunId,
			taskId,
			result,
		})
		this.log.info(`Agent task completed: ${taskId}`)
		this.scheduleEviction(taskId)
		this.resolveCompletionCallbacks(taskId)
	}

	private markFailed(taskId: TaskId, error: string): void {
		const agentTask = this.instances.get(taskId)
		if (!agentTask || isTerminalAgentTaskState(agentTask.state)) return

		agentTask.result = {
			runId: agentTask.context.parentRunId,
			status: 'failed',
			usage: { ...EMPTY_TOKEN_USAGE },
			cost: { ...ZERO_COST },
			iterations: 0,
			durationMs: Date.now() - agentTask.createdAt,
			messages: [],
			lastError: error,
		}
		agentTask.completedAt = Date.now()
		this.updateState(taskId, 'failed')
		this.emit({ type: 'failed', taskId, error })
		this.emitRunEvent(agentTask, {
			type: 'agent_failed',
			runId: agentTask.context.parentRunId,
			taskId,
			error,
		})
		this.log.error(`Agent task failed: ${taskId}`, { error })
		this.scheduleEviction(taskId)
		this.resolveCompletionCallbacks(taskId)
	}

	private markCanceled(taskId: TaskId): void {
		const agentTask = this.instances.get(taskId)
		if (!agentTask || isTerminalAgentTaskState(agentTask.state)) return

		agentTask.completedAt = Date.now()
		this.updateState(taskId, 'canceled')
		this.emit({ type: 'canceled', taskId })
		this.emitRunEvent(agentTask, {
			type: 'agent_canceled',
			runId: agentTask.context.parentRunId,
			taskId,
		})
		this.log.info(`Agent task canceled: ${taskId}`)
		this.scheduleEviction(taskId)
		this.resolveCompletionCallbacks(taskId)
	}

	private updateState(taskId: TaskId, state: AgentTaskState): void {
		const agentTask = this.instances.get(taskId)
		if (agentTask) {
			agentTask.state = state
		}
	}

	private requireInstance(taskId: TaskId): AgentTask {
		const agentTask = this.instances.get(taskId)
		if (!agentTask) {
			throw new Error(`Agent task not found: "${taskId}"`)
		}
		return agentTask
	}

	private scheduleEviction(taskId: TaskId): void {
		const agentTask = this.instances.get(taskId)
		if (!agentTask) return

		agentTask.evictAfter = Date.now() + this.config.evictionMs

		const timer = setTimeout(() => {
			this.instances.delete(taskId)
			this.evictionTimers.delete(taskId)
			this.log.info(`Agent task evicted: ${taskId}`)
		}, this.config.evictionMs)

		this.evictionTimers.set(taskId, timer)
	}

	private resolveCompletionCallbacks(taskId: TaskId): void {
		const callbacks = this.completionCallbacks.get(taskId)
		if (callbacks) {
			for (const resolve of callbacks) resolve()
			this.completionCallbacks.delete(taskId)
		}
	}

	private clearEvictionTimer(taskId: TaskId): void {
		const timer = this.evictionTimers.get(taskId)
		if (timer) {
			clearTimeout(timer)
			this.evictionTimers.delete(taskId)
		}
	}

	private emit(event: AgentLifecycleEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch (err) {
				this.log.error('Agent lifecycle listener error', {
					eventType: event.type,
					error: toErrorMessage(err),
				})
			}
		}
	}

	private emitRunEvent(
		agentTask: AgentTask,
		event: import('../../types/run/events.js').RunEvent,
	): void {
		if (!agentTask.runEventListener) return
		try {
			agentTask.runEventListener(event)
		} catch (err) {
			this.log.error('RunEvent emission error', {
				eventType: event.type,
				taskId: agentTask.taskId,
				error: toErrorMessage(err),
			})
		}
	}
}
