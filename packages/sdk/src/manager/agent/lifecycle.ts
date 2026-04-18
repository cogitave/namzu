import { AGENT_MANAGER_DEFAULTS } from '../../constants/agent/index.js'
import { EMPTY_TOKEN_USAGE } from '../../constants/limits.js'
import type { AgentRegistry } from '../../registry/agent/definitions.js'
import { RUN_EVENT_SCHEMA_VERSION } from '../../session/events/schema-version.js'
import {
	type CapacityValidator,
	DelegationCapacityExceeded,
} from '../../session/handoff/capacity.js'
import type { ActorRef } from '../../session/hierarchy/actor.js'
import type { Lineage } from '../../session/hierarchy/lineage.js'
import type { SessionSummaryMaterializer } from '../../session/summary/materialize.js'
import type { SessionSummaryOutcome } from '../../session/summary/ref.js'
import type { WorkspaceRef } from '../../session/workspace/ref.js'
import type { WorkspaceBackendRegistry } from '../../session/workspace/registry.js'
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
import type { AgentId, RunId, SessionId, TaskId, TenantId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import type { RunEvent, RunEventListener } from '../../types/run/events.js'
import type { SubSessionId } from '../../types/session/ids.js'
import type { SessionStore } from '../../types/session/store.js'
import { createChildAbortController } from '../../utils/abort.js'
import { ZERO_COST } from '../../utils/cost.js'
import { toErrorMessage } from '../../utils/error.js'
import { generateTaskId } from '../../utils/id.js'
import { type Logger, getRootLogger } from '../../utils/logger.js'

/**
 * Dependencies threaded into {@link AgentManager}. Phase 6 promoted the
 * SubSession + Session + WorkspaceRef triple to mandatory spawn primitives —
 * these collaborators replace the old `Object.assign({sourceAgentId,
 * parentTaskId})` loose-cast cadence with a typed {@link Lineage} +
 * {@link SessionSummaryMaterializer} closure of the parent→child message gap.
 *
 * Phase 9 Known Delta #5: fields are now unconditional required. The legacy
 * "run without deps" compat branch was removed; every `AgentManager` consumer
 * (SDK internals, `@namzu/agents`, `@namzu/api`, `@namzu/cli`) MUST wire the
 * full set before instantiating. Convention #0 (no workarounds): the
 * partially-wired mode was a migration-window bridge; 0.2.0 closes it.
 *
 * `workspaceRegistry` is required but may be empty — spawns without a
 * registered workspace backend still succeed with `workspaceRef: undefined`
 * (the runtime uses `.has(backend)` to gate provisioning). This keeps the
 * registry deny-by-default while matching pattern doc §7.1 (lazy workspace
 * provisioning).
 */
export interface AgentManagerDeps {
	readonly sessionStore: SessionStore
	readonly workspaceRegistry: WorkspaceBackendRegistry
	readonly summaryMaterializer: SessionSummaryMaterializer
	readonly capacity: CapacityValidator
}

interface ChildSpawnRecord {
	subSessionId: SubSessionId
	childSessionId: SessionId
	tenantId: TenantId
	parentSessionId: SessionId
	rootSessionId: SessionId
	childDepth: number
	workspaceRef?: WorkspaceRef
}

export class AgentManager {
	private registry: AgentRegistry
	private instances: Map<TaskId, AgentTask> = new Map()
	private spawnRecords: Map<TaskId, ChildSpawnRecord> = new Map()
	private completionCallbacks: Map<TaskId, Array<() => void>> = new Map()
	private listeners: AgentLifecycleListener[] = []
	private log: Logger
	private config: Readonly<AgentManagerConfig>
	private evictionTimers: Map<TaskId, ReturnType<typeof setTimeout>> = new Map()
	private deps: AgentManagerDeps

	constructor(
		registry: AgentRegistry,
		config: Partial<AgentManagerConfig> | undefined,
		deps: AgentManagerDeps,
	) {
		this.registry = registry
		this.config = { ...AGENT_MANAGER_DEFAULTS, ...config }
		this.log = getRootLogger().child({ component: 'AgentManager' })
		this.deps = deps
	}

	async sendMessage(
		options: SendMessageOptions,
		context: AgentTaskContext,
		listener?: RunEventListener,
	): Promise<AgentTask> {
		if (context.depth >= this.config.maxDepth) {
			throw new Error(
				`Max task depth ${this.config.maxDepth} exceeded (current: ${context.depth}). Recursive agent delegation is limited to prevent resource exhaustion.`,
			)
		}

		if (options.tenantId !== context.tenantId) {
			throw new Error(
				`Tenant mismatch: options.tenantId=${options.tenantId} differs from context.tenantId=${context.tenantId}. Cross-tenant spawn rejected (Convention #17).`,
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

		// Phase 6: SubSession + child Session + WorkspaceRef triple. Happens
		// before taskId minting so a capacity failure short-circuits cleanly
		// with no observable state change.
		const spawnRecord = await this.provisionSpawn(options, context)

		const taskId = generateTaskId()

		const childParentActor: ActorRef = {
			kind: 'agent',
			agentId: context.parentAgentId as AgentId,
			tenantId: context.tenantId,
			parentActor: context.parentActor,
		}

		const childContext: AgentTaskContext = {
			parentRunId: context.parentRunId,
			parentAgentId: context.parentAgentId,
			parentAbortController: context.parentAbortController,
			depth: context.depth + 1,
			budgetTracker: context.budgetTracker,
			factoryOptions: context.factoryOptions,
			tenantId: context.tenantId,
			sessionId: spawnRecord.childSessionId,
			projectId: context.projectId,
			parentActor: childParentActor,
		}

		const agentTask: AgentTask = {
			taskId,
			agentId: options.agentId,
			agent,
			childAbortController,
			context: childContext,
			state: 'pending',
			pendingMessages: [],
			createdAt: Date.now(),
			runEventListener: listener,
		}

		this.instances.set(taskId, agentTask)
		this.spawnRecords.set(taskId, spawnRecord)
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

			const lineage: Lineage = {
				parentSessionId: spawnRecord.parentSessionId,
				rootSessionId: spawnRecord.rootSessionId,
				depth: spawnRecord.childDepth,
			}
			listener({
				type: 'subsession_spawned',
				runId: context.parentRunId,
				subSessionId: spawnRecord.subSessionId,
				parentSessionId: spawnRecord.parentSessionId,
				spawnedBy: context.parentActor,
				lineage,
				schemaVersion: RUN_EVENT_SCHEMA_VERSION,
				at: new Date(),
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
				parentRunId: context.parentRunId as string | undefined,
				depth: context.depth + 1,
				...options.configOverrides,
			})

			if (!childConfig.contextLevel && definition.contextLevel) {
				childConfig.contextLevel = definition.contextLevel
			}

			// Propagate session-hierarchy scoping onto the child config. The
			// configBuilder may not have been updated to emit these yet; we
			// stamp them here so query() sees them regardless.
			childConfig.sessionId = spawnRecord?.childSessionId ?? context.sessionId
			childConfig.projectId = context.projectId
			childConfig.tenantId = context.tenantId
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
				sessionId: spawnRecord.childSessionId,
				projectId: context.projectId,
				tenantId: context.tenantId,
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

	getSpawnRecord(taskId: TaskId): ChildSpawnRecord | undefined {
		return this.spawnRecords.get(taskId)
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
				this.spawnRecords.delete(taskId)
			}
		}
	}

	dispose(): void {
		for (const taskId of this.instances.keys()) {
			this.clearEvictionTimer(taskId)
		}
		this.cancelAll('' as RunId)
		this.instances.clear()
		this.spawnRecords.clear()
		this.listeners.length = 0
	}

	private async provisionSpawn(
		options: SendMessageOptions,
		context: AgentTaskContext,
	): Promise<ChildSpawnRecord> {
		// Phase 9: deps are unconditional required. Every spawn produces a
		// SubSession + Session + WorkspaceRef triple (Convention #0: no
		// partial/legacy path).
		const store = this.deps.sessionStore

		const project = await store.getProject(context.projectId, context.tenantId)
		if (!project) {
			throw new Error(
				`Project ${context.projectId} not found for tenant ${context.tenantId} — spawn rejected`,
			)
		}

		// Capacity: depth + width. Depth uses the parent session's ancestry
		// chain; width counts existing direct children of the parent.
		await this.deps.capacity.validateDepth(
			options.parentSessionId,
			project.config.maxDelegationDepth,
			context.tenantId,
		)
		await this.deps.capacity.validateWidth(
			options.parentSessionId,
			1,
			project.config.maxDelegationWidth,
			context.tenantId,
		)

		// Ancestry walk gives both the child depth and the root session id
		// attached to every sub-session event from here down.
		const parentAncestry = await store.getAncestry(options.parentSessionId, context.tenantId)
		const rootSessionId = parentAncestry[0] ?? options.parentSessionId
		const childDepth = parentAncestry.length

		const childActor: ActorRef = {
			kind: 'agent',
			agentId: options.agentId as AgentId,
			tenantId: context.tenantId,
			parentActor: context.parentActor,
		}

		const childSession = await store.createSession(
			{ projectId: context.projectId, currentActor: childActor },
			context.tenantId,
		)

		// Flip to 'active' so the materializer's atomic write + status flip
		// lands on terminal — §5.3: pending→active→idle.
		await store.updateSession({ ...childSession, status: 'active' }, context.tenantId)

		const subSession = await store.createSubSession(
			{
				parentSessionId: options.parentSessionId,
				childSessionId: childSession.id,
				kind: 'agent_spawn',
				spawnedBy: context.parentActor,
				failureMode: 'delegate',
				completionMode: 'summary_ref',
			},
			context.tenantId,
		)

		// Workspace provisioning — best-effort. When the requested backend is
		// registered we create a new workspace for the child; failures surface
		// as WorkspaceBackendError and abort the spawn (Convention #0: no
		// silent fallback). Pattern doc §7.1 allows lazy provisioning: an
		// unregistered backend leaves `workspaceRef: undefined` on the spawn
		// record, not a hard error — the registry is the capability surface.
		let workspaceRef: WorkspaceRef | undefined
		const backend = options.workspaceBackend ?? 'git-worktree'
		if (this.deps.workspaceRegistry.has(backend)) {
			const driver = this.deps.workspaceRegistry.get(backend)
			try {
				workspaceRef = await driver.create({ label: subSession.id })
			} catch (err) {
				// Surface the failure — the subsession record exists but is
				// unusable without a workspace. Dispose any partial state.
				await store.updateSubSession({ ...subSession, status: 'failed' }, context.tenantId)
				throw err
			}
		}

		return {
			subSessionId: subSession.id,
			childSessionId: childSession.id,
			tenantId: context.tenantId,
			parentSessionId: options.parentSessionId,
			rootSessionId,
			childDepth,
			workspaceRef,
		}
	}

	private async runChild(
		agentTask: AgentTask,
		options: SendMessageOptions,
		childConfig: BaseAgentConfig,
		listener?: RunEventListener,
	): Promise<void> {
		this.updateState(agentTask.taskId, 'running')
		this.emit({ type: 'running', taskId: agentTask.taskId })

		const input = {
			...options.input,
			signal: agentTask.childAbortController.signal,
		}

		const spawnRecord = this.spawnRecords.get(agentTask.taskId)
		const childListener = this.wrapChildListener(listener, spawnRecord)

		const result = await agentTask.agent.run(input, childConfig, childListener)
		await this.finalizeChild(agentTask, result)
	}

	/**
	 * Wraps the parent listener so every event emitted from the child's run
	 * carries the session-hierarchy `lineage` + `schemaVersion: 2` stamp.
	 * Replaces the old `Object.assign({sourceAgentId, parentTaskId}, event)`
	 * loose-cast pattern entirely — the types now encode the linkage.
	 */
	private wrapChildListener(
		listener: RunEventListener | undefined,
		spawnRecord: ChildSpawnRecord | undefined,
	): RunEventListener | undefined {
		if (!listener) return undefined
		if (!spawnRecord) return listener

		const lineage: Lineage = {
			parentSessionId: spawnRecord.parentSessionId,
			rootSessionId: spawnRecord.rootSessionId,
			depth: spawnRecord.childDepth,
		}

		return async (event: RunEvent): Promise<void> => {
			const stamped: RunEvent = {
				...(event as RunEvent),
				lineage,
				schemaVersion: RUN_EVENT_SCHEMA_VERSION,
			} as RunEvent
			await listener(stamped)
		}
	}

	private async finalizeChild(agentTask: AgentTask, result: BaseAgentResult): Promise<void> {
		const spawnRecord = this.spawnRecords.get(agentTask.taskId)

		// Kernel terminalization (§8.1): Materializer seals the summary and
		// atomically flips the child session active→idle. Only run when the
		// child actually succeeded; failed sub-sessions skip materialization
		// and transition the sub-session record to 'failed' (§5.5).
		if (spawnRecord) {
			const store = this.deps.sessionStore
			try {
				if (result.status === 'completed') {
					const outcome: SessionSummaryOutcome = deriveOutcome(result)
					const agentSummary = deriveAgentSummary(result)
					const summary = await this.deps.summaryMaterializer.materialize({
						sessionId: spawnRecord.childSessionId,
						tenantId: spawnRecord.tenantId,
						finalOutcome: outcome,
						agentSummary,
						declaredDeliverables: [],
						keyDecisions: [],
					})

					const subSession = await store.getSubSession(
						spawnRecord.subSessionId,
						spawnRecord.tenantId,
					)
					if (subSession) {
						await store.updateSubSession(
							{ ...subSession, status: 'idle', summaryRef: summary.id },
							spawnRecord.tenantId,
						)
					}
				} else {
					// Non-success: mark sub-session failed and, when we own a
					// workspace, dispose it. Dispose errors are logged but not
					// propagated — the sub-session state is already persisted.
					const subSession = await store.getSubSession(
						spawnRecord.subSessionId,
						spawnRecord.tenantId,
					)
					if (subSession) {
						await store.updateSubSession({ ...subSession, status: 'failed' }, spawnRecord.tenantId)
					}
					if (spawnRecord.workspaceRef) {
						const backend = spawnRecord.workspaceRef.meta.backend
						if (this.deps.workspaceRegistry.has(backend)) {
							await this.deps.workspaceRegistry
								.get(backend)
								.dispose(spawnRecord.workspaceRef)
								.catch((disposeErr) => {
									this.log.warn('Workspace dispose failed', {
										backend,
										error: toErrorMessage(disposeErr),
									})
								})
						}
					}
				}
			} catch (err) {
				this.log.error('Sub-session finalization failed', {
					taskId: agentTask.taskId,
					error: toErrorMessage(err),
				})
			}
		}

		// Emit subsession_idled event on success before marking the task
		// completed — consumers expect the ordering `run_completed (child) →
		// subsession_idled → run_completed (parent)` per §10.5.
		if (spawnRecord && agentTask.runEventListener && result.status === 'completed') {
			const lineage: Lineage = {
				parentSessionId: spawnRecord.parentSessionId,
				rootSessionId: spawnRecord.rootSessionId,
				depth: spawnRecord.childDepth,
			}
			try {
				await agentTask.runEventListener({
					type: 'subsession_idled',
					runId: agentTask.context.parentRunId,
					subSessionId: spawnRecord.subSessionId,
					parentSessionId: spawnRecord.parentSessionId,
					lineage,
					schemaVersion: RUN_EVENT_SCHEMA_VERSION,
					at: new Date(),
				})
			} catch (err) {
				this.log.error('subsession_idled emission error', {
					taskId: agentTask.taskId,
					error: toErrorMessage(err),
				})
			}
		}

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

		// Best-effort: mark sub-session failed + dispose workspace. The result
		// emission path already synthesized a failure result above.
		const spawnRecord = this.spawnRecords.get(taskId)
		if (spawnRecord) {
			this.failSubSession(spawnRecord).catch((err) => {
				this.log.warn('SubSession failure update failed', {
					taskId,
					error: toErrorMessage(err),
				})
			})
		}

		this.scheduleEviction(taskId)
		this.resolveCompletionCallbacks(taskId)
	}

	private async failSubSession(spawnRecord: ChildSpawnRecord): Promise<void> {
		const subSession = await this.deps.sessionStore.getSubSession(
			spawnRecord.subSessionId,
			spawnRecord.tenantId,
		)
		if (subSession && subSession.status !== 'failed') {
			await this.deps.sessionStore.updateSubSession(
				{ ...subSession, status: 'failed' },
				spawnRecord.tenantId,
			)
		}
		if (spawnRecord.workspaceRef) {
			const backend = spawnRecord.workspaceRef.meta.backend
			if (this.deps.workspaceRegistry.has(backend)) {
				await this.deps.workspaceRegistry
					.get(backend)
					.dispose(spawnRecord.workspaceRef)
					.catch(() => undefined)
			}
		}
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
			this.spawnRecords.delete(taskId)
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

	private emitRunEvent(agentTask: AgentTask, event: RunEvent): void {
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

/**
 * Maps a {@link BaseAgentResult} to {@link SessionSummaryOutcome}. Phase 6
 * INTERPRETATION: `completed` → `succeeded`; any other status → `failed`.
 * A dedicated `partial` signal requires structured-output contracts on the
 * child's terminal turn (§8.1) which lands in a later phase.
 */
function deriveOutcome(result: BaseAgentResult): SessionSummaryOutcome {
	if (result.status === 'completed') {
		return { status: 'succeeded' }
	}
	const verdict = result.lastError ?? String(result.status)
	return { status: 'failed', verdict }
}

const SUMMARY_FALLBACK_MAX_CHARS = 4000

/**
 * Pulls the agent's own narration from the final assistant message. §8.1:
 * agents may register a structured-output contract for this; when absent
 * we fall back to the last text block. Bounded by the summary char cap so
 * the materializer never rejects on length at this seam.
 */
function deriveAgentSummary(result: BaseAgentResult): string {
	const fromResult = result.result?.trim()
	if (fromResult) {
		return fromResult.length > SUMMARY_FALLBACK_MAX_CHARS
			? fromResult.slice(0, SUMMARY_FALLBACK_MAX_CHARS)
			: fromResult
	}
	for (let i = result.messages.length - 1; i >= 0; i--) {
		const msg = result.messages[i]
		if (msg?.role === 'assistant') {
			const content = typeof msg.content === 'string' ? msg.content : ''
			if (content.trim().length > 0) {
				return content.length > SUMMARY_FALLBACK_MAX_CHARS
					? content.slice(0, SUMMARY_FALLBACK_MAX_CHARS)
					: content
			}
		}
	}
	return ''
}

// Re-export the capacity-violation type so downstream consumers that import
// via the AgentManager module surface don't reach into session/handoff/.
export { DelegationCapacityExceeded }
