import { AGENT_MANAGER_DEFAULTS } from '../../constants/agent/index.js'
import { EMPTY_TOKEN_USAGE } from '../../constants/limits.js'
import { GENAI } from '../../constants/telemetry/index.js'
import type { AgentRegistry } from '../../registry/agent/definitions.js'
import {
	type CapacityValidator,
	DelegationCapacityExceeded,
} from '../../session/handoff/capacity.js'
import type { SessionSummaryMaterializer } from '../../session/summary/materialize.js'
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
import { NamzuError } from '../../types/errors/index.js'
import type { RunId, SessionId, TaskId, TenantId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import { type CancelCause, RunCancelled } from '../../types/run/cancel-cause.js'
import type { RunEvent, RunEventListener } from '../../types/run/events.js'
import type { Lineage } from '../../types/run/lineage.js'
import { RUN_EVENT_SCHEMA_VERSION } from '../../types/run/schema-version.js'
import type { ActorRef } from '../../types/session/actor.js'
import type { SubSessionId } from '../../types/session/ids.js'
import type { SessionStore } from '../../types/session/store.js'
import type { SessionSummaryOutcome } from '../../types/summary/ref.js'
import type { WorkspaceRef } from '../../types/workspace/ref.js'
import { createChildAbortController } from '../../utils/abort.js'
import { ZERO_COST } from '../../utils/cost.js'
import { toErrorMessage } from '../../utils/error.js'
import { generateTaskId } from '../../utils/id.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import { requireOpenProject } from '../project/lifecycle.js'
import { type TopicManagerDependency, resolveTopicManager } from '../topic/dependency.js'
import type { TopicManager } from '../topic/lifecycle.js'

/**
 * Dependencies threaded into {@link AgentManager}. Phase 6 promoted the
 * SubSession + Session + WorkspaceRef triple to mandatory spawn primitives —
 * these collaborators replace the old `Object.assign({sourceAgentId,
 * parentTaskId})` loose-cast cadence with a typed {@link Lineage} +
 * {@link SessionSummaryMaterializer} closure of the parent→child message gap.
 *
 * Phase 9 Known Delta #5: fields are now unconditional required. The legacy
 * "run without deps" compat branch was removed; every `AgentManager` consumer
 * (SDK internals and `@namzu/cli`; the list here once also named two packages
 * that do not exist) MUST wire the full set before instantiating. Convention #0 (no workarounds): the
 * partially-wired mode was a migration-window bridge; 0.2.0 closes it.
 *
 * `workspaceRegistry` is required but may be empty — spawns without a
 * registered workspace backend still succeed with `workspaceRef: undefined`
 * (the runtime uses `.has(backend)` to gate provisioning). This keeps the
 * registry deny-by-default while matching pattern doc §7.1 (lazy workspace
 * provisioning).
 */
interface AgentManagerBaseDeps {
	readonly sessionStore: SessionStore
	readonly workspaceRegistry: WorkspaceBackendRegistry
	readonly summaryMaterializer: SessionSummaryMaterializer
	readonly capacity: CapacityValidator

	/**
	 * A pre-built logger. No in-package caller threads a real one today —
	 * `packages/cli/src/integrations/subagents/runtime.ts` is the only
	 * production `new AgentManager(...)` call, and CLI wiring is out of this
	 * task's scope (`packages/cli` is not counted by `getRootLoggerCount`,
	 * which is SDK-only) — but the field is genuinely host-reachable: it is
	 * a plain object-literal parameter (no exported type import required to
	 * satisfy it structurally) on `AgentManager`, which IS exported from
	 * `public-runtime.ts`. Same standing as `RunConfig.logger` when it was
	 * first added.
	 */
	readonly log?: Logger
}

/**
 * Dependencies for {@link AgentManager}.
 *
 * `topicManager` gates child-session creation on the parent Topic being open.
 * The deprecated `threadManager` spelling remains accepted for one migration
 * window through {@link TopicManagerDependency}; new callers use
 * `topicManager`.
 */
export type AgentManagerDeps = AgentManagerBaseDeps & TopicManagerDependency

/** Internal backpressure: the parent's unmeasured request owns its budget until its receipt. */
class ParentBudgetRequestPending extends Error {}

interface PendingSpawn {
	ready: boolean
	readonly task: AgentTask
	readonly options: SendMessageOptions
	readonly context: AgentTaskContext
	readonly listener?: RunEventListener
	readonly removeAbortListener: () => void
}

interface ChildSpawnRecord {
	subSessionId: SubSessionId
	childSessionId: SessionId
	tenantId: TenantId
	parentSessionId: SessionId
	rootSessionId: SessionId
	childDepth: number
	workspaceRef?: WorkspaceRef
	/**
	 * What this child was actually granted, after the ancestor union.
	 *
	 * Recorded rather than left implicit so a test — and an operator reading
	 * a spawn record — can ask what a child was allowed, instead of
	 * inferring it from whether a call happened to be refused.
	 */
	resolvedToolDenies?: readonly string[]
}

/**
 * Combine a child's own environment with what its parent passed down.
 *
 * Per key, override winning — not whole-value replacement, which would drop
 * every key a `configBuilder` set and the caller did not happen to restate.
 * `configOverrides` is a `Partial`, so replacement reads as "the caller
 * supplied an environment" when what they supplied was one variable.
 *
 * Returns `undefined` when both sides are empty, so an agent that never had an
 * environment does not gain an empty object it then has to be checked for.
 */
function mergeEnv(
	base: Readonly<Record<string, string>> | undefined,
	override: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
	if (!base && !override) return undefined
	return { ...base, ...override }
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
	/** One provisioning at a time per parent — see {@link provisionSpawn}. */
	private spawnLocks: Map<SessionId, Promise<void>> = new Map()
	private deps: AgentManagerDeps
	private topicManager: TopicManager
	private readonly pendingSpawns = new Map<SessionId, PendingSpawn[]>()
	private readonly drainingParents = new Set<SessionId>()
	private readonly executingTasks = new Set<TaskId>()
	private readonly cancelingTasks = new Set<TaskId>()
	private admissionTimer: ReturnType<typeof setTimeout> | undefined
	private disposed = false

	constructor(
		registry: AgentRegistry,
		config: Partial<AgentManagerConfig> | undefined,
		deps: AgentManagerDeps,
	) {
		this.registry = registry
		this.config = { ...AGENT_MANAGER_DEFAULTS, ...config }
		const maxPending = this.config.maxPendingTasks ?? 128
		if (!Number.isSafeInteger(maxPending) || maxPending < 1)
			throw new Error('maxPendingTasks must be a positive safe integer')
		this.log = resolveLogger(deps.log).child({
			[SCOPE_ATTRIBUTE]: 'manager/agent/lifecycle',
		})
		this.deps = deps
		this.topicManager = resolveTopicManager(deps)
	}

	async sendMessage(
		options: SendMessageOptions,
		context: AgentTaskContext,
		listener?: RunEventListener,
	): Promise<AgentTask> {
		if (this.disposed) throw new Error('Agent manager is disposed')
		if (this.config.capacityBehavior === 'queue')
			return this.enqueueMessage(options, context, listener)
		return this.startMessage(options, context, listener)
	}

	private async enqueueMessage(
		options: SendMessageOptions,
		context: AgentTaskContext,
		listener?: RunEventListener,
	): Promise<AgentTask> {
		context.parentAbortController.signal.throwIfAborted()
		if (context.depth >= this.config.maxDepth)
			throw new Error(`Max task depth ${this.config.maxDepth} exceeded`)
		if (options.tenantId !== context.tenantId)
			throw new Error('Tenant mismatch: cross-tenant spawn rejected')
		const definition = this.registry.getOrThrow(options.agentId)
		const count = [...this.pendingSpawns.values()].reduce((sum, queue) => sum + queue.length, 0)
		if (count >= (this.config.maxPendingTasks ?? 128))
			throw new Error(
				`Delegation queue is full (${this.config.maxPendingTasks ?? 128} pending tasks). Wait for existing tasks before submitting more work.`,
			)
		const task: AgentTask = {
			taskId: generateTaskId(),
			agentId: options.agentId,
			agent: definition.typedAgent,
			childAbortController: createChildAbortController(context.parentAbortController),
			context,
			state: 'pending',
			pendingMessages: [],
			createdAt: Date.now(),
			runEventListener: listener,
		}
		this.instances.set(task.taskId, task)
		const onAbort = (): void => {
			// Before admission this observer owns cancellation. Once child scope
			// exists, startup rollback may abort its controller for a configuration
			// error; that is a failure, not a user cancellation.
			if (task.context === context || context.parentAbortController.signal.aborted)
				this.cancel(task.taskId, 'parent')
		}
		task.childAbortController.signal.addEventListener('abort', onAbort, { once: true })
		const entry: PendingSpawn = {
			ready: false,
			task,
			options,
			context,
			listener,
			removeAbortListener: () =>
				task.childAbortController.signal.removeEventListener('abort', onAbort),
		}
		const queue = this.pendingSpawns.get(options.parentSessionId) ?? []
		queue.push(entry)
		this.pendingSpawns.set(options.parentSessionId, queue)
		this.emit({
			type: 'pending',
			taskId: task.taskId,
			agentId: options.agentId,
			parentAgentId: context.parentAgentId,
			depth: context.depth,
		})
		try {
			await listener?.({
				type: 'agent_pending',
				runId: context.parentRunId,
				taskId: task.taskId,
				parentAgentId: context.parentAgentId,
				childAgentId: options.agentId,
				depth: context.depth,
			})
			entry.ready = true
		} catch (error) {
			this.failAdmission(entry, error)
		}
		this.pumpAdmissions(options.parentSessionId)
		return task
	}

	private pumpAdmissions(parentSessionId: SessionId): void {
		if (this.disposed || this.drainingParents.has(parentSessionId)) return
		this.drainingParents.add(parentSessionId)
		void this.drainAdmissions(parentSessionId)
			.finally(() => {
				this.drainingParents.delete(parentSessionId)
				// External handoffs and metadata changes have no manager event. A
				// single slow, unref'ed timer observes those without spinning or
				// keeping a host alive. Actual completions wake admission directly.
				if (!this.disposed && this.pendingSpawns.size > 0 && !this.admissionTimer) {
					this.admissionTimer = setTimeout(() => {
						this.admissionTimer = undefined
						for (const parent of this.pendingSpawns.keys()) this.pumpAdmissions(parent)
					}, 250)
					this.admissionTimer.unref?.()
				}
			})
			.catch((error) =>
				this.log.error('Delegation admission failed', {
					'exception.message': toErrorMessage(error),
				}),
			)
	}

	private async drainAdmissions(parentSessionId: SessionId): Promise<void> {
		const queue = this.pendingSpawns.get(parentSessionId)
		if (!queue) return
		while (!this.disposed && queue.length > 0) {
			const entry = queue[0]
			if (!entry) break
			if (isTerminalAgentTaskState(entry.task.state)) {
				entry.removeAbortListener()
				queue.shift()
				continue
			}
			// A concurrent enqueue can pump this same FIFO while the head's
			// pending listener still owns its acknowledgement. Do not provision
			// or spend until that acknowledgement succeeds.
			if (!entry.ready) return
			try {
				await entry.options.beforeStart?.()
				entry.task.childAbortController.signal.throwIfAborted()
				await this.validateSpawn(entry.options, entry.context)
				entry.task.childAbortController.signal.throwIfAborted()
				await this.startMessage(entry.options, entry.context, entry.listener, entry.task)
				entry.removeAbortListener()
			} catch (error) {
				if (
					(error instanceof ParentBudgetRequestPending ||
						(error instanceof DelegationCapacityExceeded && error.details.dimension === 'width')) &&
					!isTerminalAgentTaskState(entry.task.state)
				)
					return
				this.failAdmission(entry, error)
			}
			queue.shift()
		}
		if (queue.length === 0 && this.pendingSpawns.get(parentSessionId) === queue)
			this.pendingSpawns.delete(parentSessionId)
	}

	private failAdmission(entry: PendingSpawn, reason: unknown): void {
		entry.removeAbortListener()
		const task = entry.task
		if (isTerminalAgentTaskState(task.state)) return
		task.childAbortController.abort(reason)
		const error = toErrorMessage(reason)
		task.result = {
			runId: entry.context.parentRunId,
			status: 'failed',
			usage: { ...EMPTY_TOKEN_USAGE },
			cost: { ...ZERO_COST },
			iterations: 0,
			durationMs: Date.now() - task.createdAt,
			messages: [],
			lastError: error,
		}
		task.state = 'failed'
		task.completedAt = Date.now()
		this.emit({ type: 'failed', taskId: task.taskId, error })
		this.emitRunEvent(task, {
			type: 'agent_failed',
			runId: entry.context.parentRunId,
			taskId: task.taskId,
			error,
		})
		this.scheduleEviction(task.taskId)
		this.resolveCompletionCallbacks(task.taskId)
	}

	private async startMessage(
		options: SendMessageOptions,
		context: AgentTaskContext,
		listener?: RunEventListener,
		queuedTask?: AgentTask,
	): Promise<AgentTask> {
		await options.beforeStart?.()
		queuedTask?.childAbortController.signal.throwIfAborted()
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

		// A shell this task has to itself, not the registry's shared instance.
		//
		// `resolve` returns one `typedAgent` per registered id, and an instance
		// refuses a second concurrent `run` because it holds per-run state. So
		// a fan-out naming the same `agent_id` four times drove four runs at one
		// shell: one worked and three died with `ConcurrentInvocationError` —
		// while `create_task`'s own description tells the model that this
		// fan-out is the thing to do. Observed live on 12.0.1, four launches,
		// three lost.
		//
		// The remedy was already written down — "a host that wants parallelism
		// constructs a second instance" — and was unreachable here, because the
		// definition owns the instance and this path only has an id.
		//
		// Nothing else about the child is shared: its abort signal is the task's
		// own (`input.signal` below), its config is rebuilt per spawn by
		// `configBuilder`, and the manager cancels through the task rather than
		// the agent. The shell was the only shared thing left.
		const definitionForSpawn = this.registry.getOrThrow(options.agentId)
		const sharedAgent = definitionForSpawn.typedAgent
		const agent = definitionForSpawn.createAgent?.() ?? sharedAgent.forRun?.() ?? sharedAgent

		context.parentAbortController.signal.throwIfAborted()

		// Reserve synchronously before provisioning yields. The authority is shared
		// across managers and nested sessions, while the session lock below only
		// serializes filesystem capacity checks.
		// Queued siblings share the available budget with the parent. The first
		// of eight children receives at most one ninth; later siblings receive
		// comparable grants instead of a geometric 1/2, 1/4, ... starvation tail.
		let budgetShares = 1
		if (queuedTask) {
			const project = await requireOpenProject(
				this.deps.sessionStore,
				context.projectId,
				context.tenantId,
				'spawn',
			)
			const children = await this.deps.sessionStore.getChildren(
				options.parentSessionId,
				context.tenantId,
			)
			const active = children.filter(
				(child) =>
					child.status !== 'idle' && child.status !== 'failed' && child.status !== 'archived',
			).length
			budgetShares = Math.max(2, project.config.maxDelegationWidth - active + 1)
		}
		context.parentAbortController.signal.throwIfAborted()
		queuedTask?.childAbortController.signal.throwIfAborted()
		const remaining = context.budget.remaining
		const maxAllocation = Number.isFinite(remaining)
			? Math.floor(Math.min(remaining * this.config.maxBudgetFraction, remaining / budgetShares))
			: (options.budgetAllocation?.tokenBudget ??
				(options.configOverrides?.tokenBudget === 0
					? 200_000
					: (options.configOverrides?.tokenBudget ?? 200_000)))
		const allocatedTokens = Math.min(
			options.budgetAllocation?.tokenBudget ?? maxAllocation,
			maxAllocation,
		)
		if (!Number.isSafeInteger(allocatedTokens) || allocatedTokens <= 0) {
			throw new NamzuError({
				code: 'invalid_config',
				message: `Cannot spawn "${options.agentId}": the parent has ${remaining} tokens remaining; a child allocation must be a finite positive integer.`,
			})
		}
		// No await between this check and reserve: a parent's response may start
		// during the scope reads above. Its own in-flight request is temporary
		// backpressure; descendant requests are expected during a fan-out.
		// Invalid/zero allocations above still fail rather than waiting forever.
		if (queuedTask && context.budget.hasInFlightRequest)
			throw new ParentBudgetRequestPending('The parent provider request is still in flight')
		const childBudget = context.budget.reserve(allocatedTokens)
		let spawnRecord: ChildSpawnRecord
		try {
			await childBudget.flush()
			spawnRecord = await this.provisionSpawn(options, context)
		} catch (error) {
			childBudget.settle(0)
			await childBudget.flush()
			throw error
		}
		let childAbortController: AbortController | undefined
		let agentTask: AgentTask | undefined
		try {
			childAbortController =
				queuedTask?.childAbortController ??
				createChildAbortController(context.parentAbortController)

			childAbortController.signal.throwIfAborted()
			const taskId = queuedTask?.taskId ?? generateTaskId()

			const childParentActor: ActorRef = {
				kind: 'agent',
				agentId: context.parentAgentId,
				tenantId: context.tenantId,
				parentActor: context.parentActor,
			}

			// The union of every deny along the chain, plus this spawn's own.
			//
			// Without it, NZ-GATE-09's scope stopped at one level: a child denied
			// `bash` could spawn a grandchild naming no scope, and the grandchild
			// got bash back. A restriction that a descendant can shed by
			// delegating is not a restriction.
			//
			// No containment CHECK here, deliberately. The obvious shape is to
			// confirm with `isDescendantOfActor` that the child really sits under
			// the actor whose scope is being inherited — but `childParentActor`
			// is built two statements up FROM `context.parentActor`, so the
			// answer is yes by construction and the branch could never be taken.
			// A check that cannot fail reads as a safeguard and is not one. The
			// predicate is exported for the callers that do face an actor they
			// did not construct: an audit walking a subtree, a host asking
			// whether one run's actor is contained by another's.
			//
			// Union, not replace, and not "innermost wins": a descendant may
			// narrow further and may never widen.
			const inheritedDenies = context.toolDenies ?? []
			const ownDenies = options.toolScope?.deny ?? []
			const resolvedDenies = [...new Set([...inheritedDenies, ...ownDenies])]

			const childContext: AgentTaskContext = {
				parentRunId: context.parentRunId,
				parentAgentId: context.parentAgentId,
				parentAbortController: context.parentAbortController,
				depth: context.depth + 1,
				budget: childBudget,
				factoryOptions: context.factoryOptions,
				tenantId: context.tenantId,
				topicId: context.topicId,
				sessionId: spawnRecord.childSessionId,
				projectId: context.projectId,
				parentActor: childParentActor,
				...(resolvedDenies.length > 0 ? { toolDenies: resolvedDenies } : {}),
			}

			agentTask = Object.assign(queuedTask ?? {}, {
				taskId,
				agentId: options.agentId,
				agent,
				childAbortController,
				context: childContext,
				state: 'pending',
				pendingMessages: queuedTask?.pendingMessages ?? [],
				createdAt: queuedTask?.createdAt ?? Date.now(),
				runEventListener: listener,
			} satisfies AgentTask)

			childAbortController.signal.throwIfAborted()
			this.instances.set(taskId, agentTask)
			if (resolvedDenies.length > 0) spawnRecord.resolvedToolDenies = resolvedDenies
			this.spawnRecords.set(taskId, spawnRecord)
			if (!queuedTask)
				this.emit({
					type: 'pending',
					taskId,
					agentId: options.agentId,
					parentAgentId: context.parentAgentId,
					depth: context.depth,
				})

			if (listener) {
				if (!queuedTask)
					await listener({
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
				await listener({
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
			this.log.info('Agent task pending', {
				'namzu.agent.task_id': taskId,
				'namzu.agent.definition_id': options.agentId,
				'namzu.agent.depth': context.depth,
			})

			const definition = this.registry.getOrThrow(options.agentId)
			let childConfig: BaseAgentConfig
			if (definition.configBuilder) {
				// Call the configBuilder regardless of whether factoryOptions were
				// supplied. BYO-provider flows (ambient cloud credentials, a custom registry)
				// commonly omit factoryOptions because the provider resolves its own
				// credentials; the builder still needs to run to wire provider+tools.
				// Defaults: empty factoryOptions when omitted; configOverrides win.
				childConfig = {
					...(await definition.configBuilder({
						...(context.factoryOptions ?? {}),
						tokenBudget: allocatedTokens,
						timeoutMs: options.budgetAllocation?.timeoutMs ?? this.config.childTimeoutMs,
						parentRunId: context.parentRunId as string | undefined,
						depth: context.depth + 1,
						...options.configOverrides,
					})),
				}

				if (!childConfig.contextLevel && definition.contextLevel) {
					childConfig.contextLevel = definition.contextLevel
				}

				// Propagate session-hierarchy scoping onto the child config. The
				// configBuilder may not have been updated to emit these yet; we
				// stamp them here so query() sees them regardless.
				childConfig.sessionId = spawnRecord?.childSessionId ?? context.sessionId
				childConfig.topicId = context.topicId
				childConfig.projectId = context.projectId
				childConfig.tenantId = context.tenantId
				// Stamp the trace parent the same way, rather than trusting every
				// configBuilder to forward an option it may not know about.
				if (options.configOverrides?.parentSpan) {
					childConfig.parentSpan = options.configOverrides.parentSpan
				}
				// Stamped for the same reason as the trace parent above: a
				// `configBuilder` is written by whoever registered the agent and
				// cannot be trusted to forward something it was never told about.
				// An explicit override still wins, so a host can hand one child a
				// different channel — or none.
				//
				// Without this every delegated child fell through to
				// `autoApproveHandler`, so a host's "ask before acting" gate
				// covered the top-level run and nothing it delegated.
				const inheritedHandler = options.configOverrides?.resumeHandler ?? context.resumeHandler
				if (inheritedHandler) childConfig.resumeHandler = inheritedHandler

				// And the environment, for the third time and the same reason.
				//
				// The bare-config branch below has always carried `env`; this one
				// never did, so a delegate registered WITH a `configBuilder` — the
				// normal way, and what every host in this repo does — silently ran
				// with none of the environment its parent had been given. The
				// builder is written by whoever registered the agent and cannot be
				// expected to forward a field it was never told about, which is
				// exactly why `parentSpan` and `resumeHandler` are stamped here too.
				//
				// Merged per key rather than replaced. `configOverrides` is a
				// `Partial`, so assigning the whole map would drop every key the
				// builder set and the caller did not restate — the override wins per
				// key, the same direction it already wins for `model` and `effort`.
				const inheritedEnv = mergeEnv(childConfig.env, options.configOverrides?.env)
				if (inheritedEnv) childConfig.env = inheritedEnv
				// A builder may ignore a newly-added factory option. The requested root
				// policy is an execution boundary, so stamp an explicit child override
				// after the builder rather than silently falling back to ephemeral.
				if (options.configOverrides?.sandbox) {
					childConfig.sandbox = options.configOverrides.sandbox
				}
			} else {
				this.log.warn('No configBuilder, using bare config', {
					[GENAI.AGENT_ID]: options.agentId,
				})
				childConfig = {
					model: options.configOverrides?.model ?? 'default',
					tokenBudget: allocatedTokens,
					timeoutMs: options.budgetAllocation?.timeoutMs ?? this.config.childTimeoutMs,
					streamIdleTimeoutMs: options.configOverrides?.streamIdleTimeoutMs,
					maxRequestRichContentBytes: options.configOverrides?.maxRequestRichContentBytes,
					attachmentResolveTimeoutMs: options.configOverrides?.attachmentResolveTimeoutMs,
					temperature: options.configOverrides?.temperature,
					parentSpan: options.configOverrides?.parentSpan,
					maxIterations: options.configOverrides?.maxIterations,
					maxResponseTokens: options.configOverrides?.maxResponseTokens,
					// A delegate spawned without a configBuilder lands here, and this
					// list is the only thing it inherits. Omitting these meant a child
					// silently ran at the default depth and effort its parent had
					// deliberately moved off.
					thinking: options.configOverrides?.thinking,
					effort: options.configOverrides?.effort,
					env: options.configOverrides?.env,
					sandbox: options.configOverrides?.sandbox,
					sessionId: spawnRecord.childSessionId,
					topicId: context.topicId,
					projectId: context.projectId,
					tenantId: context.tenantId,
					parentRunId: context.parentRunId,
					depth: context.depth + 1,
					resumeHandler: options.configOverrides?.resumeHandler ?? context.resumeHandler,
				}
			}

			// Lineage is assigned by the spawning manager, not proposed by the
			// child definition. A fixed configBuilder can ignore its inputs and
			// configOverrides is caller-authored; neither may turn a child back
			// into depth zero or attach it to a different parent run.
			childConfig.parentRunId = context.parentRunId
			childConfig.depth = context.depth + 1
			childConfig.budget = childBudget
			// The reservation is the execution ceiling, regardless of a builder's
			// defaults or configOverrides. Zero means unlimited to query(), so it
			// must inherit the finite allocation rather than erase that ceiling.
			if (!Number.isFinite(childConfig.tokenBudget) || childConfig.tokenBudget < 0) {
				throw new NamzuError({
					code: 'invalid_config',
					message: `Invalid child token budget for "${options.agentId}": ${childConfig.tokenBudget}`,
				})
			}
			childConfig.tokenBudget =
				childConfig.tokenBudget === 0
					? allocatedTokens
					: Math.min(childConfig.tokenBudget, allocatedTokens)
			childBudget.narrow(childConfig.tokenBudget)

			// Stamped AFTER the builder, for the fourth time and the same reason:
			// a `configBuilder` is written by whoever registered the agent and
			// cannot forward a field it was never told about. A scope applied
			// before it would be silently discarded by every builder that returns
			// a fixed config — which is most of them.
			//
			// OUTSIDE the branch, unlike the four stamps above, and that is the
			// point. Written inside the `configBuilder` arm it read correctly and
			// left the bare-config arm below ignoring `toolScope` entirely — a
			// caller that asked for a narrower child got a wider one, silently,
			// and in the only direction that matters. Every other field here is
			// an inheritance, where missing it costs the child something; this
			// one is a restriction, where missing it costs the CALLER something.
			//
			// Narrowing only: the deny list is SUBTRACTED from whatever the child
			// would otherwise have. `allowedTools` absent means "every registered
			// tool", so a deny with no existing allow-list has to be resolved
			// against the registry at the run rather than here — which `query()`
			// does, and which is why this appends to `deniedTools` rather than
			// synthesising an allow-list.
			if (resolvedDenies.length > 0) {
				childConfig.deniedTools = [
					...new Set([...(childConfig.deniedTools ?? []), ...resolvedDenies]),
				]
			}
			if (options.personaOverride) childConfig.persona = options.personaOverride

			// Outside the branch, like the scope above it and for the same reason:
			// a `configBuilder` cannot forward a field it was never told about.
			//
			// Bound to the taskId rather than to the task object, so a drain after
			// the task is gone throws where the caller is instead of returning an
			// empty array from a closure over a corpse.
			//
			// This is the delivery point `pendingMessages` never had.
			// `continueTask` and `queueMessage` pushed onto it and nothing in the
			// kernel drained it — the manager interface's own docblock said "the
			// runtime does not deliver it", and `continue_task` was unmounted from
			// the coordinator tools because of that.
			childConfig.inboundMessages = () => this.drainMessages(taskId)
			childAbortController.signal.throwIfAborted()

			await childBudget.flush()
			childAbortController.signal.throwIfAborted()
			this.executingTasks.add(taskId)
			const runningTask = agentTask
			this.runChild(runningTask, options, childConfig, listener)
				.catch(async (err) => {
					// A thrown invocation supplied no final usage receipt. Keep its
					// reservation, including when its task handle was canceled or evicted.
					let failure = err
					try {
						await childBudget.flush()
					} catch (writeError) {
						failure = writeError
					}
					// Cancellation may already have published a terminal handle. Its
					// invocation has only NOW stopped; release the persisted edge here.
					if (!this.instances.has(taskId) || isTerminalAgentTaskState(runningTask.state)) {
						await this.failSubSession(spawnRecord)
					} else this.markFailed(taskId, toErrorMessage(failure))
				})
				.finally(() => {
					this.executingTasks.delete(taskId)
					if (!this.instances.has(taskId)) this.spawnRecords.delete(taskId)
					this.pumpAdmissions(options.parentSessionId)
				})
				.catch((error) =>
					this.log.warn('Child cleanup failed', {
						'namzu.task.id': taskId,
						'exception.message': toErrorMessage(error),
					}),
				)

			return agentTask
		} catch (err) {
			// No child invocation has been admitted: all reserved tokens and all
			// provisioned resources are still ours to return. A builder/listener
			// failure must not strand a pending task the caller never received.
			if (agentTask) {
				await this.rollbackUnstartedSpawn(agentTask, spawnRecord, err, queuedTask !== undefined)
			} else {
				childAbortController?.abort()
				childBudget.settle(0)
				await childBudget.flush()
				await this.rollbackSpawnResources(spawnRecord)
			}
			throw err
		}
	}

	private async rollbackUnstartedSpawn(
		agentTask: AgentTask,
		spawnRecord: ChildSpawnRecord,
		reason: unknown,
		retainHandle = false,
	): Promise<void> {
		agentTask.childAbortController.abort()
		agentTask.context.budget.settle(0)
		await agentTask.context.budget.flush()
		if (!isTerminalAgentTaskState(agentTask.state)) {
			agentTask.state = 'failed'
			const error = toErrorMessage(reason)
			this.emit({ type: 'failed', taskId: agentTask.taskId, error })
			try {
				await agentTask.runEventListener?.({
					type: 'agent_failed',
					runId: agentTask.context.parentRunId,
					taskId: agentTask.taskId,
					error,
				})
			} catch (err) {
				this.log.warn('Unstarted child failure notification failed', {
					'namzu.task.id': agentTask.taskId,
					'exception.message': toErrorMessage(err),
				})
			}
		}
		this.clearEvictionTimer(agentTask.taskId)
		if (retainHandle) {
			agentTask.result ??= {
				runId: agentTask.context.parentRunId,
				status: 'failed',
				usage: { ...EMPTY_TOKEN_USAGE },
				cost: { ...ZERO_COST },
				iterations: 0,
				durationMs: Date.now() - agentTask.createdAt,
				messages: [],
				lastError: toErrorMessage(reason),
			}
			agentTask.completedAt = Date.now()
			this.scheduleEviction(agentTask.taskId)
		} else this.instances.delete(agentTask.taskId)
		this.spawnRecords.delete(agentTask.taskId)
		this.resolveCompletionCallbacks(agentTask.taskId)
		await this.rollbackSpawnResources(spawnRecord)
	}

	private async rollbackSpawnResources(spawnRecord: ChildSpawnRecord): Promise<void> {
		await this.disposeChildWorkspace(spawnRecord)
		try {
			// The edge must be removed before its child: stores reject deletion
			// of a session that still has a subsession reference.
			await this.deps.sessionStore.deleteSubSession(spawnRecord.subSessionId, spawnRecord.tenantId)
			await this.deps.sessionStore.deleteSession(spawnRecord.childSessionId, spawnRecord.tenantId)
		} catch (err) {
			this.log.warn('Unstarted child rollback failed', {
				'namzu.sub_session.id': spawnRecord.subSessionId,
				'exception.message': toErrorMessage(err),
			})
		}
	}

	cancel(taskId: TaskId, cause?: CancelCause): void {
		if (this.cancelingTasks.has(taskId)) return
		const agentTask = this.instances.get(taskId)
		if (!agentTask || isTerminalAgentTaskState(agentTask.state)) return

		// Was the bare string `'canceled'`, which `abortReasonText` suppresses
		// by name — its docblock cites this exact call site — so the child's
		// run saw a cancellation with no attributable origin at all.
		// Abort listeners run synchronously. A pending task's parent observer
		// must not reenter this method and replace an explicit user's cause.
		this.cancelingTasks.add(taskId)
		try {
			agentTask.childAbortController.abort(cause ? new RunCancelled(cause) : undefined)
			this.markCanceled(taskId, cause)
		} finally {
			this.cancelingTasks.delete(taskId)
		}
	}

	cancelAll(parentRunId: RunId, cause: CancelCause = 'parent'): void {
		// `'parent'` by default, because this call site IS a parent
		// abandoning its children. `AbstractAgent.cancel` takes no default
		// for the opposite reason: its caller could be anyone.
		for (const agentTask of this.listByParent(parentRunId)) {
			this.cancel(agentTask.taskId, cause)
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
		this.log.info('Message queued for task via continueTask', {
			'namzu.agent.task_id': taskId,
		})
	}

	queueMessage(taskId: TaskId, message: Message): void {
		const agentTask = this.requireInstance(taskId)
		// Refused on a settled task, like `continueTask` above. A silent push
		// leaves the caller believing something is in flight when the only
		// thing that would ever have drained it has finished.
		if (isTerminalAgentTaskState(agentTask.state)) {
			throw new Error(
				`Cannot queue a message for terminal task: ${taskId} (state: ${agentTask.state})`,
			)
		}
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
				if (!this.executingTasks.has(taskId)) this.spawnRecords.delete(taskId)
			}
		}
	}

	dispose(): void {
		this.disposed = true
		if (this.admissionTimer) clearTimeout(this.admissionTimer)
		this.admissionTimer = undefined
		for (const queue of this.pendingSpawns.values())
			for (const entry of queue) entry.removeAbortListener()
		this.pendingSpawns.clear()
		for (const taskId of this.instances.keys()) {
			this.clearEvictionTimer(taskId)
		}
		// Every live child, not the children of one parent. This used to call
		// `cancelAll('' as RunId)`, and `cancelAll` filters by parent run —
		// no task has an empty parent, so it matched nothing and the lines
		// below then dropped every reference to work that was still running.
		for (const taskId of [...this.instances.keys()]) {
			this.cancel(taskId)
		}
		this.instances.clear()
		for (const taskId of this.spawnRecords.keys())
			if (!this.executingTasks.has(taskId)) this.spawnRecords.delete(taskId)
		this.listeners.length = 0
	}

	/**
	 * Serializes provisioning per parent session.
	 *
	 * The width cap counted existing children and then created one, with
	 * every remaining provisioning step in between. Two concurrent spawns
	 * under the same parent both read the same count, both saw room, and
	 * both created — so a cap of N admitted N+1. The check and the write
	 * that invalidates it have to be one critical section, and the parent
	 * session is the narrowest key that makes them one: spawns under
	 * different parents never contend.
	 *
	 * In-process only, which is the honest scope. Cross-process capacity is
	 * the store's to enforce, and no store here spans processes.
	 */
	private async provisionSpawn(
		options: SendMessageOptions,
		context: AgentTaskContext,
	): Promise<ChildSpawnRecord> {
		const key = options.parentSessionId
		const queued = (this.spawnLocks.get(key) ?? Promise.resolve()).then(
			() => this.provisionSpawnUnlocked(options, context),
			// A failed predecessor releases the lock rather than wedging every
			// later spawn under the same parent.
			() => this.provisionSpawnUnlocked(options, context),
		)
		const barrier = queued.then(
			() => undefined,
			() => undefined,
		)
		this.spawnLocks.set(key, barrier)
		try {
			return await queued
		} finally {
			// Clear the slot only if nobody queued behind us — otherwise we
			// would drop the barrier the next waiter is chained to, and the
			// map would leak one entry per parent if we never cleared at all.
			if (this.spawnLocks.get(key) === barrier) this.spawnLocks.delete(key)
		}
	}

	private async validateSpawn(
		options: SendMessageOptions,
		context: AgentTaskContext,
	): Promise<void> {
		// Phase 9: deps are unconditional required. Every spawn produces a
		// SubSession + Session + WorkspaceRef triple (Convention #0: no
		// partial/legacy path).
		const store = this.deps.sessionStore

		// Topic archive gate — runs FIRST so an archived Topic fails fastest
		// with the correct error (not DelegationCapacityExceeded or a project
		// lookup error). Phase 2.6 closes the gap the Phase 2.5 commit
		// flagged: without it, `TopicManager.archive` could be undermined by
		// a concurrent spawn landing a live session post-archival.
		// Scope: this gate enforces the archive invariant at the production
		// ingress path (AgentManager.sendMessage + handoff flows). Direct
		// callers of `SessionStore.createSession` bypass it — the store layer
		// is intentionally unaware of topic status to preserve its
		// single-responsibility boundary.
		await this.topicManager.requireOpen(context.topicId, context.tenantId)

		// Parent session cross-check: validate that `options.parentSessionId`
		// exists for this tenant AND lives under the same topic as the
		// context. A mismatched `context.topicId` would otherwise attach the
		// child's sub-session edge to a parent in a different topic —
		// corrupting the hierarchy invariant (cross-topic spawn is forbidden
		// by design). Mirrors the `source.topicId === assignment.topicId`
		// check in handoff (Phase 2.4).
		const parentSession = await store.getSession(options.parentSessionId, context.tenantId)
		if (!parentSession) {
			throw new Error(
				`Parent session ${options.parentSessionId} not found for tenant ${context.tenantId} — spawn rejected`,
			)
		}
		if (parentSession.status === 'archived')
			throw new Error('Delegation parent session is archived')
		if (parentSession.topicId !== context.topicId) {
			throw new Error(
				`Topic mismatch on spawn: parent session ${parentSession.id} is on topic ${parentSession.topicId}, but context.topicId=${context.topicId}. Cross-topic spawn is forbidden (session-hierarchy.md §6.3).`,
			)
		}
		if (parentSession.projectId !== context.projectId) {
			throw new Error(
				`Project mismatch on spawn: parent session ${parentSession.id} is on project ${parentSession.projectId}, but context.projectId=${context.projectId}.`,
			)
		}

		// Same read that loads the limits, now also the gate: an archived
		// workspace accepts no new session. It replaces a bare `getProject` +
		// null check rather than adding a round-trip, because a gate that costs
		// something is a gate someone eventually moves.
		const project = await requireOpenProject(store, context.projectId, context.tenantId, 'spawn')

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
	}

	private async provisionSpawnUnlocked(
		options: SendMessageOptions,
		context: AgentTaskContext,
	): Promise<ChildSpawnRecord> {
		await this.validateSpawn(options, context)
		context.parentAbortController.signal.throwIfAborted()
		const store = this.deps.sessionStore

		// Ancestry walk gives both the child depth and the root session id
		// attached to every sub-session event from here down.
		const parentAncestry = await store.getAncestry(options.parentSessionId, context.tenantId)
		const rootSessionId = parentAncestry[0] ?? options.parentSessionId
		const childDepth = parentAncestry.length

		const childActor: ActorRef = {
			kind: 'agent',
			agentId: options.agentId,
			tenantId: context.tenantId,
			parentActor: context.parentActor,
		}

		// Child session inherits the parent's topicId verbatim (cross-topic
		// spawn is forbidden by design — a delegated sub-agent stays on the
		// same topic). Phase 2.6 elides the previous parent-session read by
		// carrying `topicId` on `AgentTaskContext`.
		const childSession = await store.createSession(
			{
				topicId: context.topicId,
				projectId: context.projectId,
				currentActor: childActor,
			},
			context.tenantId,
		)

		// Compensating rollback wraps every mutation after createSession so a
		// mid-flight failure (status flip, subsession insert, workspace driver)
		// leaves no orphan child session. spawn-rollback critique (Phase
		// 2 review, 2026-04-18): without this, `workspaceRegistry.get().create`
		// throwing — or a concurrent `updateSession` race — leaves stranded an
		// `active` child session with no subsession edge, invisible to the
		// parent but counted against `maxDelegationWidth`.
		let subSession: Awaited<ReturnType<typeof store.createSubSession>> | undefined
		let workspaceRef: WorkspaceRef | undefined
		try {
			// Flip to 'active' so the materializer's atomic write + status flip
			// lands on terminal — §5.3: pending→active→idle.
			await store.updateSession({ ...childSession, status: 'active' }, context.tenantId)

			subSession = await store.createSubSession(
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

			// Workspace provisioning — best-effort. When the requested backend
			// is registered we create a new workspace for the child; failures
			// surface as WorkspaceBackendError and abort the spawn (Convention
			// #0: no silent fallback). Pattern doc §7.1 allows lazy
			// provisioning: an unregistered backend leaves `workspaceRef:
			// undefined` on the spawn record, not a hard error — the registry
			// is the capability surface.
			const backend = options.workspaceBackend ?? 'git-worktree'
			if (this.deps.workspaceRegistry.has(backend)) {
				const driver = this.deps.workspaceRegistry.get(backend)
				workspaceRef = await driver.create({ label: subSession.id })

				// Write the workspace onto the record that outlives this process.
				//
				// The ref was kept only on the in-memory `ChildSpawnRecord`, so
				// `SubSession.workspaceId` stayed `null` for every spawn-created
				// child — and `ArchivalManager` resolves a workspace only when
				// that field is set (`session/retention/archive.ts`). The one
				// record that could have named the workspace said there was none,
				// which is why the archival path could never act as a backstop
				// for a leaked worktree.
				//
				// After `create` rather than in `createSubSession`, because the
				// sub-session id is the workspace's label — the workspace cannot
				// exist before the record it is named after. Inside the try, so
				// the compensating rollback below covers it like every other
				// mutation here.
				subSession = { ...subSession, workspaceId: workspaceRef.id }
				await store.updateSubSession(subSession, context.tenantId)
			}
		} catch (err) {
			if (workspaceRef && subSession) {
				await this.disposeChildWorkspace({
					workspaceRef,
					subSessionId: subSession.id,
				})
			}
			// Compensating rollback order is mandated by the store's
			// deny-by-default cascade policy (Convention #5): `deleteSession`
			// throws when any subsession still references it, so the subsession
			// record must be removed first. No failed-subsession audit row is
			// kept — the `subsession_spawned` run event never fired (we aborted
			// before `buildSpawnRecord`), so no observer is expecting one, and
			// leaving a `status: 'failed'` breadcrumb would be a dangling
			// record with no corresponding emission. The original `err` is the
			// caller-visible signal; cleanup errors are swallowed so they
			// cannot mask it.
			if (subSession !== undefined) {
				await store.deleteSubSession(subSession.id, context.tenantId).catch(() => undefined)
			}
			await store.deleteSession(childSession.id, context.tenantId).catch(() => undefined)
			throw err
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
		agentTask.context.budget.bindRun(result.runId)
		agentTask.context.budget.settle(result.usage?.totalTokens)
		await agentTask.context.budget.flush()
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
					// Non-success: mark sub-session failed. Disposal is shared with
					// the success branch below — the workspace was provisioned for
					// this child either way, and it is this manager that owns it.
					const subSession = await store.getSubSession(
						spawnRecord.subSessionId,
						spawnRecord.tenantId,
					)
					if (subSession) {
						await store.updateSubSession({ ...subSession, status: 'failed' }, spawnRecord.tenantId)
					}
				}

				// A child is done with its workspace however it ended.
				//
				// This used to live only in the branch above, so both dispose
				// sites in this class were failure paths and a child that
				// SUCCEEDED released nothing. `.namzu/worktrees/` then grew once
				// per successful delegation — the more reliable the workers, the
				// faster it filled, which is the opposite of the signal a leak
				// usually gives.
				//
				// It runs after the summary is sealed and the sub-session flipped
				// to `idle`, so nothing the terminalization path reads is gone
				// before it reads it. It also runs BEFORE the `subsession_idled`
				// emission below: a listener cannot reach into the workspace from
				// that event. Stated rather than hedged — no consumer does today,
				// and holding a worktree open for a hypothetical one is what this
				// is fixing.
				await this.disposeChildWorkspace(spawnRecord)
			} catch (err) {
				this.log.error('Sub-session finalization failed', {
					'namzu.task.id': agentTask.taskId,
					'exception.message': toErrorMessage(err),
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
					'namzu.task.id': agentTask.taskId,
					'exception.message': toErrorMessage(err),
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
		this.log.info('Agent task completed', { 'namzu.agent.task_id': taskId })
		this.scheduleEviction(taskId)
		this.resolveCompletionCallbacks(taskId)
	}

	private markFailed(taskId: TaskId, error: string): void {
		const agentTask = this.instances.get(taskId)
		if (!agentTask || isTerminalAgentTaskState(agentTask.state)) return

		agentTask.result = {
			runId: agentTask.context.budget.runId ?? agentTask.context.parentRunId,
			status: 'failed',
			usage: agentTask.context.budget.ownUsage,
			budget: agentTask.context.budget.summary(),
			cost: { ...ZERO_COST, unpricedTokens: agentTask.context.budget.ownTokens },
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
		this.log.error('Agent task failed', {
			'namzu.agent.task_id': taskId,
			'exception.message': error,
		})

		// Best-effort: mark sub-session failed + dispose workspace. The result
		// emission path already synthesized a failure result above.
		const spawnRecord = this.spawnRecords.get(taskId)
		if (spawnRecord) {
			this.failSubSession(spawnRecord).catch((err) => {
				this.log.warn('SubSession failure update failed', {
					'namzu.task.id': taskId,
					'exception.message': toErrorMessage(err),
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
		await this.disposeChildWorkspace(spawnRecord)
	}

	/**
	 * Release the workspace this manager provisioned for a child.
	 *
	 * Called on every terminal path, success included. `has(backend)` before
	 * `get(backend)` because the registry is deny-by-default and throws on an
	 * unknown kind — a driver deregistered mid-run must not turn cleanup into
	 * an exception on a child that already finished.
	 *
	 * Never throws. Disposal is cleanup, not part of the child's result: the
	 * sub-session state is already persisted by the time this runs, and
	 * failing here would report a delegation that worked as one that did not.
	 * The failure is logged instead, because a worktree that could not be
	 * removed is an operator's problem and silence is how it stays one.
	 */
	private async disposeChildWorkspace(
		spawnRecord: Pick<ChildSpawnRecord, 'workspaceRef' | 'subSessionId'>,
	): Promise<void> {
		if (!spawnRecord.workspaceRef) return
		const backend = spawnRecord.workspaceRef.meta.backend
		if (!this.deps.workspaceRegistry.has(backend)) return
		await this.deps.workspaceRegistry
			.get(backend)
			.dispose(spawnRecord.workspaceRef)
			.catch((disposeErr) => {
				this.log.warn('Workspace dispose failed', {
					'namzu.manager.backend': backend,
					'namzu.manager.workspace_id': spawnRecord.workspaceRef?.id,
					'namzu.sub_session.id': spawnRecord.subSessionId,
					'exception.message': toErrorMessage(disposeErr),
				})
			})
	}

	private markCanceled(taskId: TaskId, cause?: CancelCause): void {
		const agentTask = this.instances.get(taskId)
		if (!agentTask || isTerminalAgentTaskState(agentTask.state)) return

		agentTask.completedAt = Date.now()
		this.updateState(taskId, 'canceled')
		this.emit({ type: 'canceled', taskId })
		this.emitRunEvent(agentTask, {
			type: 'agent_canceled',
			runId: agentTask.context.parentRunId,
			taskId,
			...(cause ? { cancelCause: cause } : {}),
		})
		this.log.info('Agent task canceled', { 'namzu.agent.task_id': taskId })
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
		if (this.disposed) return
		const agentTask = this.instances.get(taskId)
		if (!agentTask) return

		agentTask.evictAfter = Date.now() + this.config.evictionMs

		const timer = setTimeout(() => {
			this.instances.delete(taskId)
			if (!this.executingTasks.has(taskId)) this.spawnRecords.delete(taskId)
			this.evictionTimers.delete(taskId)
			this.log.info('Agent task evicted', { 'namzu.agent.task_id': taskId })
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
					'namzu.event.type': event.type,
					'exception.message': toErrorMessage(err),
				})
			}
		}
	}

	private emitRunEvent(agentTask: AgentTask, event: RunEvent): void {
		if (!agentTask.runEventListener) return
		const reportFailure = (error: unknown): void => {
			this.log.error('RunEvent emission error', {
				'namzu.event.type': event.type,
				'exception.message': toErrorMessage(error),
			})
		}
		try {
			// Terminal observation must not delay completion or leak a rejected
			// listener promise into the host as an unhandled rejection.
			void Promise.resolve(agentTask.runEventListener(event)).catch(reportFailure)
		} catch (error) {
			reportFailure(error)
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
