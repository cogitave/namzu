/**
 * Sub-agent runtime: the model delegates work via an `Agent` tool that can
 * DEFINE a specialist on the fly — pass a `role` (the persona / system prompt)
 * and namzu spins up a fresh sub-agent with that role at runtime, no
 * pre-registered definition needed. Omit `role` for a general-purpose one.
 * The call waits for a final result unless background execution is requested
 * or operator input releases the wait.
 * The child then stays owned by the parent run, and its completion reaches the
 * same query's inbox. Headless callers also support explicit background work.
 *
 * The runtime is fully self-contained: a dedicated in-memory session/thread
 * store backs the AgentManager, so sub-agent bookkeeping never touches the
 * CLI's on-disk `/resume` conversation store. A separate session-scoped
 * receipt archive preserves observed outcomes without restoring execution authority.
 */

import {
	type ActorRef,
	type AgentDefinition,
	type AgentFileDefinition,
	AgentManager,
	AgentRegistry,
	type AgentTaskContext,
	type AuthorizationGateConfig,
	type BaseAgentConfig,
	type BaseAgentResult,
	type CancelCause,
	CompletionInbox,
	type Agent as CoreAgent,
	type CreateTaskOptions,
	DefaultCapacityValidator,
	EXPLORE_AGENT_DESCRIPTION,
	EXPLORE_AGENT_ID,
	EXPLORE_AGENT_PROMPT,
	InMemorySessionStore,
	InMemoryTopicStore,
	type LLMProvider,
	LocalTaskScheduler,
	type PathBuilder,
	type Project,
	type ProjectInstructionContext,
	ReactiveAgent,
	type ReactiveAgentConfig,
	type ReasoningEffort,
	type ResumeHandler,
	RunCancelled,
	type RunEvent,
	type RunId,
	type SandboxProvider,
	type SessionId,
	SessionSummaryMaterializer,
	type TaskHandle,
	type TaskId,
	type TaskScheduler,
	type ToolContext,
	type ToolDefinition,
	type ToolRegistryContract,
	type ToolResult,
	type Topic,
	TopicArchivedError,
	TopicManager,
	WorkspaceBackendRegistry,
	asRunId,
	asTaskId,
	defineTool,
	filterReadOnlyTools,
	filterToolsNamed,
	generateSummaryId,
	isTerminalAgentTaskState,
	mcpJsonSchemaToZod,
	openTokenBudget,
	requireOpenProject,
} from '@namzu/sdk'

import { NAMZU_WORKING_DOCTRINE } from '../../context/doctrine.js'
import {
	MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS,
	MAX_AGENT_PHASE_ORDER,
	SubagentActivityMonitor,
	type SubagentActivitySource,
} from './activity.js'
import { DelegationHistory, HISTORY_GUIDANCE } from './history.js'
import { CLI_INTERACTIVE_RUN_TIMEOUT_MS } from './policy.js'

export const GENERAL_PURPOSE_SUBAGENT = 'general-purpose'
/**
 * The kernel's read-only delegate, with this application's doctrine under
 * its prompt. Roster and prompt come from `@namzu/sdk`; what is added here is
 * the same working rules every namzu child gets.
 */
export const EXPLORE_SUBAGENT = EXPLORE_AGENT_ID

const EXPLORE_PROMPT = [EXPLORE_AGENT_PROMPT, '', NAMZU_WORKING_DOCTRINE].join('\n')

/**
 * A file-defined agent's roster: the parent's working set, kept to the
 * file's `tools` allowlist when there is one, and to read-only tools when
 * the file says `readOnly: true`. Intersection, never union.
 */
function fileAgentTools(
	definition: AgentFileDefinition,
	opts: SubagentRuntimeOptions,
): () => ToolRegistryContract {
	return () => {
		const source = definition.readOnly ? filterReadOnlyTools(opts.buildTools()) : opts.buildTools()
		return definition.tools ? filterToolsNamed(source, definition.tools) : source
	}
}

const SUBAGENT_PROMPT = [
	'You are a focused sub-agent dispatched by namzu to complete one self-contained task and report back.',
	'You cannot see the parent conversation — work only from the prompt you were given.',
	'Use your tools to actually do the work, then end with a concise summary of what you did and any results the parent needs.',
	'Be thorough but do not ask the parent questions; make reasonable assumptions and state them.',
	'',
	'Never fabricate. Only report results you actually produced via tool calls:',
	'- If you create a file, create it with the `write` tool; if you change an existing one, use `edit`. Report the real path either way; never claim a file exists without a tool having written it.',
	'- If you need to research and have no web tool available, say so plainly and answer from your own knowledge with that caveat — do not invent sources, data, or URLs.',
	'- Do not invent command output or results. If you cannot complete the task, say what blocked you.',
	'',
	// The same working rules the parent runs under. A delegated task edits the
	// same repository, and a child that reads a file before editing it while
	// the parent does not is the same defect in the other direction.
	NAMZU_WORKING_DOCTRINE,
].join('\n')

export interface SubagentParent {
	readonly project: Project
	readonly topic: Topic
	readonly sessionId: SessionId
}

export interface DelegatedModel {
	readonly provider: string
	readonly model: string
	readonly effort?: ReasoningEffort
}

export interface SubagentRuntimeOptions {
	/** Resolve the actual invoking run; reject calls whose parent no longer exists. */
	readonly resolveParent: (runId: RunId) => Promise<SubagentParent>
	readonly cwd: string
	/** Private project root for session-scoped delegation receipts. */
	readonly historyRoot?: string
	readonly model: string
	/** Aggregate parent-and-descendant limit; absent or zero means unlimited. */
	readonly tokenBudget?: number
	/** Durable layout for child runs; omitted preserves the SDK default. */
	readonly pathBuilder?: PathBuilder
	/** Root every child allocation at the session workspace or a fresh temp tree. */
	readonly sandboxWorkspace?: 'working-directory' | 'ephemeral'
	/** Construct a fresh provider with the invoking conversation and current credential. */
	readonly buildProvider: (
		parentSessionId?: SessionId,
		selection?: DelegatedModel,
	) => LLMProvider | Promise<LLMProvider>
	readonly resolveModel?: (
		request: { model: string; provider?: string; effort?: string },
		signal: AbortSignal,
	) => Promise<DelegatedModel>
	readonly listModels?: (query: string, signal: AbortSignal) => Promise<string>
	/** Build the sub-agent's tool registry (its own working set). */
	readonly buildTools: () => ToolRegistryContract
	readonly authorizationGate?: AuthorizationGateConfig
	/**
	 * Resolve the interactive authority owned by the parent run that invoked
	 * the Agent tool. Absent means the child has no human review channel.
	 */
	readonly resolveResumeHandler?: (runId: ToolContext['runId']) => ResumeHandler | undefined
	/** Wake a delegation wait when this parent has undelivered operator input. */
	readonly resolveWaitForInbound?: (
		runId: RunId,
	) => ((signal: AbortSignal) => Promise<void>) | undefined
	/** Use the same execution boundary the parent session reports. */
	readonly sandboxProvider?: SandboxProvider
	/** Bound child teardown with the parent's operator-selected value. */
	readonly sandboxTeardownTimeoutMs?: number
	/** A fresh drain cursor over the session's shared project-policy state. */
	readonly projectInstructionContext?: () => ProjectInstructionContext
	/**
	 * Produces the "where and when" block for a child, at the moment the child
	 * is built rather than once for the session.
	 *
	 * A function because both facts it carries can change while the parent runs:
	 * a long session crosses midnight, and the parent may itself have checked
	 * out a branch since it started. A string captured at startup would hand
	 * every later sub-agent a confident, stale answer.
	 */
	readonly readEnvironment?: () => Promise<string>
	/** Receives the child's RunEvents (lineage-stamped) — for the tree view. */
	readonly onEvent?: (event: RunEvent) => void
	/**
	 * Agents a project or user defined in `.namzu/agents/<name>.md`. Each
	 * becomes a type the `Agent` tool offers beside the built-in two, with
	 * its own prompt, roster and model. See `definitions.ts`.
	 */
	readonly definitions?: readonly AgentFileDefinition[]
}

export interface SubagentRuntime {
	/** One immutable scheduler context per actual parent run. */
	gatewayForRun(runId: RunId): Promise<TaskScheduler>
	/** The same inbox the parent query drains after a delegation yields. */
	completionInboxForRun(runId: RunId): Promise<CompletionInbox>
	/** Release a settled parent's bookkeeping and cancel children it still owns. */
	releaseRun(runId: RunId): Promise<void>
	readonly modelCatalogueTool?: ToolDefinition
	readonly agentTool: ToolDefinition
	/** Retrieve a child result without starting another task. */
	readonly waitForTaskTool: ToolDefinition
	readonly agentTaskListTool: ToolDefinition
	/** Queue a correction for an owned task that has not finished. */
	readonly sendMessageTool: ToolDefinition
	readonly cancelAgentTool: ToolDefinition
	readonly allowedAgentIds: readonly string[]
	/** Live, bounded observation of children created by this CLI session. */
	readonly activity: SubagentActivitySource
	/** Stop every child still owned by this parent session. Idempotent. */
	close(): Promise<void>
}

/** Recheck the invoking run before admitting work through a retained gateway. */
class ParentTaskScheduler extends LocalTaskScheduler {
	constructor(
		manager: AgentManager,
		context: AgentTaskContext,
		onEvent: ((event: RunEvent) => void) | undefined,
		private readonly validateParent: () => Promise<void>,
	) {
		super(manager, context, onEvent)
	}

	override async createTask(options: CreateTaskOptions): Promise<TaskHandle> {
		await this.validateParent()
		return super.createTask({
			...options,
			beforeStart: async () => {
				await options.beforeStart?.()
				await this.validateParent()
			},
		})
	}

	private owns(taskId: TaskId): boolean {
		return super.listTasks().some((task) => task.taskId === taskId)
	}

	override getTask(taskId: TaskId): TaskHandle | undefined {
		// The parent ledger retains terminal results after the manager evicts
		// its live record. Lookup and waiting must read the same owned history.
		return super.listTasks().find((task) => task.taskId === taskId)
	}

	override cancelTask(taskId: TaskId, cause?: CancelCause): void {
		if (this.owns(taskId)) super.cancelTask(taskId, cause)
	}

	override async waitForTask(taskId: TaskId): Promise<TaskHandle> {
		const task = this.getTask(taskId)
		if (!task) throw new Error(`Task ${taskId} does not belong to this parent run`)
		if (isTerminalAgentTaskState(task.state)) return task
		return super.waitForTask(taskId)
	}

	override async continueTask(taskId: TaskId, message: string): Promise<void> {
		if (!this.owns(taskId)) throw new Error(`Task ${taskId} does not belong to this parent run`)
		await this.validateParent()
		await super.continueTask(taskId, message)
	}
}

/** A delegated run may never inherit the SDK's headless auto-approval fallback. */
const refuseUnownedChildReview: ResumeHandler = async () => ({
	action: 'abort',
	reason: 'The parent run no longer owns an interactive review channel for this sub-agent.',
})

/**
 * Stand up the AgentManager + gateway + `Agent` tool. Returns the tool to
 * register on the parent and the gateway to pass to `query({ taskScheduler })`.
 */
export async function createSubagentRuntime(
	opts: SubagentRuntimeOptions,
): Promise<SubagentRuntime> {
	const registry = new AgentRegistry()
	registry.register(
		buildDefinition(
			GENERAL_PURPOSE_SUBAGENT,
			'A general-purpose sub-agent.',
			SUBAGENT_PROMPT,
			opts,
		),
	)
	registry.register(
		buildDefinition(EXPLORE_SUBAGENT, EXPLORE_AGENT_DESCRIPTION, EXPLORE_PROMPT, opts, () =>
			filterReadOnlyTools(opts.buildTools()),
		),
	)
	// Agents a project or user defined in a file, each a type of its own.
	// The roster is the file's allowlist intersected with the parent's set —
	// a file cannot grant a tool the parent does not have — narrowed further
	// to read-only when the file says so. The prompt is the file's body over
	// the same sub-agent base every child gets.
	const fileAgents = new Map<string, AgentFileDefinition>()
	for (const definition of opts.definitions ?? []) {
		fileAgents.set(definition.name, definition)
		registry.register(
			buildDefinition(
				definition.name,
				definition.description,
				definition.prompt,
				opts,
				fileAgentTools(definition, opts),
				definition.model ?? opts.model,
			),
		)
	}
	const agentTypeIds = [GENERAL_PURPOSE_SUBAGENT, EXPLORE_SUBAGENT, ...fileAgents.keys()]
	const fileAgentSummary = [...fileAgents.values()]
		.map((definition) => `"${definition.name}" — ${definition.description}`)
		.join('; ')

	interface ParentRuntime {
		readonly gateway: TaskScheduler
		readonly completionInbox: CompletionInbox
		close(): void
	}
	interface SessionRuntime {
		readonly manager: AgentManager
		readonly store: InMemorySessionStore
		readonly topicId: Topic['id']
		projectUpdatedAt: number
	}
	interface SharedSession {
		readonly ready: Promise<SessionRuntime>
		owners: number
	}
	const parents = new Map<RunId, Promise<ParentRuntime>>()
	const sessions = new Map<string, SharedSession>()
	let closed = false
	const sessionKey = ({ project, sessionId }: SubagentParent): string =>
		JSON.stringify([project.tenantId, project.id, sessionId])

	const resolveParent = async (runId: RunId): Promise<SubagentParent> => {
		const parent = structuredClone(await opts.resolveParent(runId))
		const { project, topic } = parent
		if (topic.projectId !== project.id || topic.tenantId !== project.tenantId) {
			throw new Error('Delegation parent topic does not belong to its project and tenant')
		}
		await requireOpenProject(
			{ getProject: async () => project },
			project.id,
			project.tenantId,
			'spawn',
		)
		if (topic.status === 'archived')
			throw new TopicArchivedError({ topicId: topic.id, op: 'spawn' })
		return parent
	}

	const createSessionRuntime = async (parent: SubagentParent): Promise<SessionRuntime> => {
		const { project, topic, sessionId } = parent
		const tenantId = project.tenantId
		const store = new InMemorySessionStore([project])
		const topicStore = new InMemoryTopicStore([topic])
		const parentActor: ActorRef = { kind: 'agent', agentId: 'namzu', tenantId }
		const session = await store.createSession(
			{
				id: sessionId,
				topicId: topic.id,
				projectId: project.id,
				currentActor: parentActor,
			},
			tenantId,
		)
		await store.updateSession({ ...session, status: 'active' }, tenantId)
		const manager = new AgentManager(
			registry,
			{ childTimeoutMs: CLI_INTERACTIVE_RUN_TIMEOUT_MS, capacityBehavior: 'queue' },
			{
				sessionStore: store,
				summaryMaterializer: new SessionSummaryMaterializer({
					store,
					generateSummaryId,
				}),
				workspaceRegistry: new WorkspaceBackendRegistry(),
				capacity: new DefaultCapacityValidator(store),
				topicManager: new TopicManager({ topicStore, sessionStore: store }),
			},
		)
		return {
			manager,
			store,
			topicId: topic.id,
			projectUpdatedAt: project.updatedAt.getTime(),
		}
	}

	const refreshLimits = async (shared: SessionRuntime, parent: SubagentParent): Promise<void> => {
		if (shared.topicId !== parent.topic.id)
			throw new Error('Delegation parent changed its topic while runs are active')
		// A slow metadata read must not overwrite a newer project snapshot.
		const updatedAt = parent.project.updatedAt.getTime()
		if (updatedAt < shared.projectUpdatedAt) return
		shared.projectUpdatedAt = updatedAt
		await shared.store.updateProject(
			parent.project.id,
			parent.project.config,
			parent.project.tenantId,
		)
	}

	const acquireSession = async (parent: SubagentParent) => {
		const key = sessionKey(parent)
		let entry = sessions.get(key)
		if (!entry) {
			entry = { ready: createSessionRuntime(parent), owners: 0 }
			sessions.set(key, entry)
		}
		entry.owners++
		const ownedEntry = entry
		let released = false
		const release = (): void => {
			if (released) return
			released = true
			ownedEntry.owners--
			if (ownedEntry.owners !== 0) return
			if (sessions.get(key) === ownedEntry) sessions.delete(key)
			void ownedEntry.ready.then(
				(shared) => shared.manager.dispose(),
				() => undefined,
			)
		}
		try {
			const shared = await entry.ready
			await refreshLimits(shared, parent)
			return { shared, release }
		} catch (error) {
			release()
			throw error
		}
	}

	const gatewayForRun = async (runId: RunId): Promise<TaskScheduler> => {
		if (closed) throw new Error('Sub-agent runtime is closed')
		let pending = parents.get(runId)
		if (!pending) {
			pending = (async (): Promise<ParentRuntime> => {
				const parent = await resolveParent(runId)
				const budget = await openTokenBudget({
					scope: {
						tenantId: parent.project.tenantId,
						projectId: parent.project.id,
						sessionId: parent.sessionId,
						runId,
					},
					limit: opts.tokenBudget ?? 0,
					pathBuilder: opts.pathBuilder,
					workingDirectory: opts.cwd,
				})
				const lease = await acquireSession(parent)
				const { manager } = lease.shared
				const parentAbortController = new AbortController()
				let released = false
				const assertOwned = (): void => {
					if (
						closed ||
						released ||
						parentAbortController.signal.aborted ||
						parents.get(runId) !== pending
					) {
						throw new Error(`Parent run ${runId} was released`)
					}
				}
				const taskContext: AgentTaskContext = {
					parentRunId: runId,
					parentAgentId: 'namzu',
					parentAbortController,
					depth: 0,
					budget,
					tenantId: parent.project.tenantId,
					topicId: parent.topic.id,
					sessionId: parent.sessionId,
					projectId: parent.project.id,
					parentActor: {
						kind: 'agent',
						agentId: 'namzu',
						tenantId: parent.project.tenantId,
					},
				}
				const gateway = new ParentTaskScheduler(manager, taskContext, opts.onEvent, async () => {
					assertOwned()
					const current = await resolveParent(runId)
					assertOwned()
					if (sessionKey(current) !== sessionKey(parent))
						throw new Error('Delegation run changed its parent scope')
					await refreshLimits(lease.shared, current)
					assertOwned()
				})
				const completionInbox = new CompletionInbox()
				completionInbox.attach(gateway)
				const runtime: ParentRuntime = {
					gateway,
					completionInbox,
					close() {
						if (released) return
						released = true
						parentAbortController.abort(new RunCancelled('parent'))
						manager.cancelAll(runId, 'parent')
						completionInbox.close()
						lease.release()
					},
				}
				if (closed) {
					runtime.close()
					throw new Error('Sub-agent runtime is closed')
				}
				return runtime
			})()
			parents.set(runId, pending)
		}
		try {
			const runtime = await pending
			if (closed || parents.get(runId) !== pending)
				throw new Error(`Parent run ${runId} was released`)
			return runtime.gateway
		} catch (error) {
			if (parents.get(runId) === pending) parents.delete(runId)
			throw error
		}
	}
	const releaseRun = async (runId: RunId): Promise<void> => {
		const pending = parents.get(runId)
		if (!pending) return
		parents.delete(runId)
		await pending.then(
			(runtime) => runtime.close(),
			() => undefined,
		)
	}
	const completionInboxForRun = async (runId: RunId): Promise<CompletionInbox> => {
		await gatewayForRun(runId)
		const pending = parents.get(runId)
		if (!pending) throw new Error(`Parent run ${runId} was released`)
		return (await pending).completionInbox
	}

	const activity = new SubagentActivityMonitor()

	// Dynamic `Agent` tool: the model passes an optional `role` (the persona /
	// system prompt) and we register + spawn a fresh specialist for it at call
	// time — no pre-defined agent file needed. Omit `role` → general-purpose.
	let dynCounter = 0
	const agentTool = defineTool({
		name: 'Agent',
		description: [
			'Delegate a self-contained task to a sub-agent. Set run_in_background: true to receive its task ID immediately and continue independent work; completion arrives as a task notification. Otherwise wait for its result. Operator input can also release a blocking wait while the child keeps working. Use agent_task_list for current agent status (task_list is only the planning list), send_message to correct a running task, cancel_agent to stop only one owned task, and wait_for_task to retrieve its result; never launch duplicate work.',
			'For a request to run multiple independent tasks in parallel, issue all Agent calls together in one response, or set run_in_background: true on each launch before waiting. A single blocking Agent call followed by another call runs them sequentially.',
			'Pick `subagent_type: "explore"` for anything that only needs to look — where is X defined, which files reference Y, how does Z work — it has reading and searching tools only and never asks for permission.',
			'Use the default "general-purpose" when the task must change files or run commands.',
			'Define a specialist inline with `role` — a system prompt describing who the sub-agent is and how to behave (e.g.',
			'"You are a security auditor; flag vulnerabilities and rate severity"); with `subagent_type: "explore"` the role keeps the read-only roster.',
			'Omit `role` for the plain sub-agent.',
			'The sub-agent runs in its own context with its own tools and cannot see this conversation — put everything it needs in `prompt`.',
			"Call this multiple times in one response to run specialists in parallel. Tasks beyond the project's live-agent capacity wait in a queue and start as slots become available. Queued tasks have not started execution; do not relaunch them.",
			'When coordinating several specialists, give them the same `workflow` label and an explicit `phase` plus `phase_order` so the operator can follow the work in the agent cockpit.',
			'These fields are display annotations only; they do not create dependencies, barriers, or serial execution.',
			fileAgentSummary.length > 0 ? `Project-defined types: ${fileAgentSummary}.` : '',
		]
			.filter((part) => part.length > 0)
			.join(' '),
		inputSchema: mcpJsonSchemaToZod({
			type: 'object',
			properties: {
				description: {
					type: 'string',
					description: 'Short label for tracking (shown to the user).',
				},
				prompt: {
					type: 'string',
					description: 'Self-contained task with all the context the sub-agent needs.',
				},
				run_in_background: {
					type: 'boolean',
					description:
						'Return after launch so the parent can continue independent work. Defaults to false.',
				},
				subagent_type: {
					type: 'string',
					enum: agentTypeIds,
					description: `"explore" for read-only lookups (find, search, explain); "general-purpose" (default) when the task changes files or runs commands.${
						fileAgentSummary.length > 0
							? ` This project also defines: ${fileAgentSummary}. Prefer a project-defined type when its description fits the task.`
							: ''
					}`,
				},
				model: {
					type: 'string',
					description:
						'Exact child model ID. Omit to inherit the session model. Use agent_models to discover available IDs; do not search repository files.',
				},
				provider: {
					type: 'string',
					description:
						'Provider for this child only. Requires model; does not switch the parent conversation.',
				},
				effort: {
					type: 'string',
					description:
						'Exact reasoning effort supported by the child model. Requires model. Omit for its provider default.',
				},
				role: {
					type: 'string',
					description:
						'Optional persona / system prompt that defines this specialist sub-agent. Omit for general-purpose.',
				},
				workflow: {
					type: 'string',
					maxLength: MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS,
					description:
						'Optional short workflow label shared by related delegated tasks (for example, "Release audit").',
				},
				phase: {
					type: 'string',
					maxLength: MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS,
					description:
						'Optional workflow phase shown in the agent cockpit (for example, "Research" or "Verify").',
				},
				phase_order: {
					type: 'integer',
					minimum: 0,
					maximum: MAX_AGENT_PHASE_ORDER,
					description:
						'Optional zero-based display order for the phase. Tasks in the same phase should use the same value.',
				},
			},
			required: ['description', 'prompt'],
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		timeoutMs: CLI_INTERACTIVE_RUN_TIMEOUT_MS,
		async execute(input, context) {
			const {
				description,
				prompt,
				subagent_type,
				role,
				workflow,
				phase,
				phase_order,
				run_in_background,
				model: requestedModel,
				provider: requestedProvider,
				effort: requestedEffort,
			} = input as {
				description: string
				model?: string
				provider?: string
				effort?: string
				prompt: string
				subagent_type?: string
				role?: string
				workflow?: string
				phase?: string
				phase_order?: number
				run_in_background?: boolean
			}
			if (!requestedModel && (requestedProvider || requestedEffort))
				throw new Error('Supply model when selecting a child provider or effort.')
			if (requestedModel && !opts.resolveModel)
				throw new Error('Child model selection is unavailable in this host.')
			const selection = requestedModel
				? await opts.resolveModel?.(
						{ model: requestedModel, provider: requestedProvider, effort: requestedEffort },
						context.abortSignal,
					)
				: undefined
			const explore = subagent_type === EXPLORE_SUBAGENT
			const fileAgent = subagent_type !== undefined ? fileAgents.get(subagent_type) : undefined
			let agentId = fileAgent?.name ?? (explore ? EXPLORE_SUBAGENT : GENERAL_PURPOSE_SUBAGENT)
			const persona = typeof role === 'string' ? role.trim() : ''
			const dynamic = persona.length > 0 || selection !== undefined
			if (dynamic) {
				// A role on top of a type keeps that type's roster and model: the
				// persona says who the child is, the type says what it may touch,
				// and a role must not be a way to hand a read-only child a `write`
				// tool. Over a file-defined agent the role is appended to the
				// file's prompt rather than replacing it.
				agentId = `dyn-${++dynCounter}`
				registry.register(
					buildDefinition(
						agentId,
						`Dynamic specialist: ${agentId}`,
						fileAgent
							? `${fileAgent.prompt}\n\n${persona}`
							: persona || (explore ? EXPLORE_PROMPT : SUBAGENT_PROMPT),
						opts,
						fileAgent
							? fileAgentTools(fileAgent, opts)
							: explore
								? () => filterReadOnlyTools(opts.buildTools())
								: opts.buildTools,
						selection?.model ?? fileAgent?.model ?? opts.model,
						selection,
					),
				)
			}
			const tracker = activity.begin({
				agentId,
				description,
				prompt,
				batchId: context.toolBatchId,
				toolUseId: context.toolUseId,
				workflowId: String(context.runId),
				workflow,
				phase,
				phaseOrder: phase_order,
			})
			// The child is a separate run, but its human authority belongs to the
			// parent turn that invoked Agent. `drainQuery` deliberately auto-approves
			// when a handler is omitted for headless SDK callers; omission here would
			// therefore turn a missing/stale parent mapping into permission to mutate
			// the real project. Always install a handler, and abort if ownership can no
			// longer be proved.
			const resumeHandler = opts.resolveResumeHandler?.(context.runId) ?? refuseUnownedChildReview
			const configOverrides = {
				tokenBudget: opts.tokenBudget ?? 0,
				...(selection ? { model: selection.model, effort: selection.effort } : {}),
				...(Object.keys(context.env ?? {}).length > 0 ? { env: context.env } : {}),
				resumeHandler,
			}
			let taskOwnsCleanup = false
			const cleanupDefinition = (): void => {
				if (dynamic) registry.unregister(agentId)
			}
			try {
				const completionInbox = await completionInboxForRun(context.runId)
				const parent = await resolveParent(context.runId)
				const history = opts.historyRoot
					? new DelegationHistory(opts.historyRoot, parent.sessionId)
					: undefined
				const save = (handle: TaskHandle, terminal: boolean): void => {
					history?.write({
						taskId: handle.taskId,
						parentRunId: context.runId,
						description,
						status: terminal ? agentTaskOutcome(handle) : 'unresolved',
						...(terminal ? { output: String(completedAgentResult(handle).output ?? '') } : {}),
					})
				}
				const outcome = await runBlockingAgentTask({
					gateway: await gatewayForRun(context.runId),
					signal: context.abortSignal,
					waitForInbound: opts.resolveWaitForInbound?.(context.runId),
					background: run_in_background === true,
					completionInbox,
					onCreated: (handle) => {
						save(handle, false)
						taskOwnsCleanup = true
					},
					onSettled: (completed) => {
						save(completed, true)
						tracker.settle(completed)
					},
					onFailed: (error) => tracker.fail(error),
					onFinished: cleanupDefinition,
					create: {
						agentId,
						prompt,
						workingDirectory: opts.cwd,
						// Hang the child run off THIS tool's span, so the delegation
						// shows up inside the turn that asked for it. Without it a
						// sub-agent opens its OWN root trace, and the one structure
						// a delegation trace exists to record — who dispatched whom
						// — is the thing that goes missing.
						...(context.parentSpan ? { parentSpan: context.parentSpan } : {}),
						configOverrides,
						onEvent: tracker.onEvent,
					},
				})
				if (outcome.kind === 'yielded') {
					const progress =
						outcome.handle.state === 'pending' ? 'queued for an available slot' : 'still running'
					return {
						success: true,
						output: `Sub-agent ${agentId} for task ${JSON.stringify(description)} is ${progress} as task ${outcome.handle.taskId}; it has not completed. ${run_in_background ? 'Continue independent work while this task runs in the background.' : 'Waiting was released because the operator sent a message. Answer their question or status request before making further tool calls; preserve existing work unless they ask to cancel or change it.'} Its actual result will arrive as a task notification; do not launch the same work again.`,
						data: {
							task_id: outcome.handle.taskId,
							state: outcome.handle.state,
							wait_released: run_in_background ? 'background' : 'operator_input',
						},
					}
				}
				return completedAgentResult(outcome.handle)
			} catch (error) {
				tracker.fail(error)
				throw error
			} finally {
				// A yielded task retains its definition until its actual completion.
				// Before creation succeeds, this invocation owns that cleanup.
				if (!taskOwnsCleanup) cleanupDefinition()
			}
		},
	})
	const agentTaskListTool = defineTool({
		name: 'agent_task_list',
		description:
			'List the agent invocations launched by this run and their current status, without waiting or starting work. Use this for agent progress questions. task_list contains planning items, not agent invocations. Use wait_for_task with a live ID for its result. Set history: true to inspect saved receipts from this conversation, optionally task_id for one saved result; archives do not prove liveness.',
		inputSchema: mcpJsonSchemaToZod({
			type: 'object',
			properties: { history: { type: 'boolean' }, task_id: { type: 'string' } },
			additionalProperties: false,
		}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute(input, context) {
			const request = input as { history?: boolean; task_id?: string }
			if (request.history || request.task_id) {
				if (!opts.historyRoot)
					return { success: false, output: 'Saved delegation history is unavailable in this host.' }
				const parent = await resolveParent(context.runId)
				const history = new DelegationHistory(opts.historyRoot, parent.sessionId)
				const saved = request.task_id
					? { tasks: [history.read(request.task_id)], omitted: 0 }
					: history.list()
				const tasks = saved.tasks.map(({ output, ...row }) =>
					request.task_id ? { ...row, output } : row,
				)
				return {
					success: true,
					output: JSON.stringify({ ...saved, tasks, guidance: HISTORY_GUIDANCE }),
				}
			}
			const gateway = await gatewayForRun(context.runId)
			const tasks = gateway.listTasks()
			const labels = new Map(
				activity.getSnapshot().map((entry) => [entry.taskId, entry.description]),
			)
			const shown = tasks.slice(-40).map((task) => ({
				description: labels.get(task.taskId) ?? task.agentId,
				task_id: task.taskId,
				agent: task.agentId,
				state: task.state,
				status: agentTaskOutcome(task),
				...(task.result?.stopReason ? { stop_reason: task.result.stopReason } : {}),
			}))
			return {
				success: true,
				output: JSON.stringify({
					tasks: shown,
					total: tasks.length,
					omitted: tasks.length - shown.length,
				}),
				data: { tasks: shown, total: tasks.length, omitted: tasks.length - shown.length },
			}
		},
	})

	const waitForTaskTool = defineTool({
		name: 'wait_for_task',
		description:
			'Wait for a task this run already launched, or retrieve its complete result after a task notification. This does not start new work. Operator input releases the wait while the task continues.',
		inputSchema: mcpJsonSchemaToZod({
			type: 'object',
			properties: {
				task_id: {
					type: 'string',
					description: 'The task_id from the Agent launch receipt or task notification metadata.',
				},
			},
			required: ['task_id'],
		}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		timeoutMs: CLI_INTERACTIVE_RUN_TIMEOUT_MS,
		async execute(input, context) {
			const gateway = await gatewayForRun(context.runId)
			let taskId: TaskId
			try {
				taskId = asTaskId((input as { task_id: string }).task_id)
			} catch {
				return {
					success: false,
					output: '',
					error: 'task_id must be a task UUID returned by Agent or a task notification.',
				}
			}
			const task = gateway.getTask(taskId)
			if (!task)
				return {
					success: false,
					output: '',
					error: `Task ${taskId} does not belong to this parent run.`,
				}
			const outcome = await runBlockingAgentTask({
				gateway,
				task,
				signal: context.abortSignal,
				completionInbox: await completionInboxForRun(context.runId),
				waitForInbound: opts.resolveWaitForInbound?.(context.runId),
				onCreated: () => {},
				onSettled: () => {},
				onFailed: () => {},
				onFinished: () => {},
			})
			if (outcome.kind === 'completed') return completedAgentResult(outcome.handle)
			const progress =
				outcome.handle.state === 'pending' ? 'queued for an available slot' : 'still running'
			return {
				success: true,
				output: `Task ${taskId} is ${progress}; it has not completed. Waiting was released for an operator message. Its result will arrive as a task notification.`,
				data: { task_id: taskId, state: outcome.handle.state, wait_released: 'operator_input' },
			}
		},
	})

	const sendMessageTool = defineTool({
		name: 'send_message',
		description:
			'Queue a correction or additional context for a running or queued sub-agent task owned by this run. The child receives it at its next request boundary; acceptance is not delivery. This does not start new work or restart finished tasks.',
		inputSchema: mcpJsonSchemaToZod({
			type: 'object',
			properties: {
				task_id: { type: 'string', description: 'Task UUID returned by Agent.' },
				message: {
					type: 'string',
					minLength: 1,
					maxLength: 16000,
					description: 'Correction or additional context for this task.',
				},
			},
			required: ['task_id', 'message'],
			additionalProperties: false,
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: false,
		async execute(input, context) {
			context.abortSignal.throwIfAborted()
			const { task_id, message } = input as { task_id: string; message: string }
			if (!message.trim())
				return { success: false, output: '', error: 'Message must not be blank.' }
			const taskId = asTaskId(task_id)
			const gateway = await gatewayForRun(context.runId)
			const task = gateway.getTask(taskId)
			if (!task)
				return {
					success: false,
					output: '',
					error: `Task ${taskId} does not belong to this parent run.`,
				}
			if (isTerminalAgentTaskState(task.state))
				return {
					success: false,
					output: '',
					error: 'This task has finished; send_message cannot restart it.',
				}
			context.abortSignal.throwIfAborted()
			await gateway.continueTask(taskId, message)
			return {
				success: true,
				output: `Message queued for task ${taskId}; it will be available at the child's next request boundary.`,
				data: { task_id: taskId, status: 'queued' },
			}
		},
	})

	const cancelAgentTool = defineTool({
		name: 'cancel_agent',
		description:
			'Request cancellation of one running or queued agent task owned by this run. Other agents and the parent continue. Acceptance is not proof of termination; check agent_task_list or wait_for_task for the terminal outcome. Does not restart finished tasks.',
		inputSchema: mcpJsonSchemaToZod({
			type: 'object',
			properties: {
				task_id: {
					type: 'string',
					description: 'Exact task UUID returned by Agent or agent_task_list.',
				},
			},
			required: ['task_id'],
			additionalProperties: false,
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: false,
		async execute(input, context) {
			context.abortSignal.throwIfAborted()
			const taskId = asTaskId((input as { task_id: string }).task_id)
			const gateway = await gatewayForRun(context.runId)
			const task = gateway.getTask(taskId)
			if (!task)
				return {
					success: false,
					output: '',
					error: `Task ${taskId} does not belong to this parent run.`,
				}
			if (isTerminalAgentTaskState(task.state))
				return {
					success: true,
					output: `Task ${taskId} already ended: ${agentTaskOutcome(task)}. No cancellation sent.`,
				}
			context.abortSignal.throwIfAborted()
			gateway.cancelTask(taskId, 'user')
			return {
				success: true,
				output: `Cancellation requested for task ${taskId}. Other tasks continue. Use agent_task_list or wait_for_task to confirm its terminal outcome.`,
				data: { task_id: taskId, status: 'cancellation_requested' },
			}
		},
	})

	let closePromise: Promise<void> | undefined
	const close = (): Promise<void> => {
		if (closePromise) return closePromise
		closed = true
		closePromise = Promise.all([...parents.keys()].map(releaseRun)).then(() => activity.close())
		return closePromise
	}

	const listModels = opts.listModels
	const modelCatalogueTool = listModels
		? defineTool({
				name: 'agent_models',
				description:
					'Discover connected provider/model IDs and published capabilities for delegation. Search here before choosing a child model; capability metadata is not a quality ranking.',
				inputSchema: mcpJsonSchemaToZod({
					type: 'object',
					properties: {
						query: { type: 'string', description: 'Optional provider or model name filter.' },
					},
				}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				async execute(input, context) {
					return {
						success: true,
						output: await listModels(
							(input as { query?: string }).query ?? '',
							context.abortSignal,
						),
					}
				},
			})
		: undefined

	return {
		cancelAgentTool,
		modelCatalogueTool,
		gatewayForRun,
		completionInboxForRun,
		releaseRun,
		agentTool,
		waitForTaskTool,
		agentTaskListTool,
		sendMessageTool,
		allowedAgentIds: agentTypeIds,
		activity,
		close,
	}
}

type BlockingAgentTaskInput = {
	readonly gateway: TaskScheduler
	readonly signal: AbortSignal
	readonly waitForInbound?: (signal: AbortSignal) => Promise<void>
	readonly background?: boolean
	readonly completionInbox: CompletionInbox
	readonly onCreated: (handle: TaskHandle) => void
	readonly onSettled: (handle: TaskHandle) => void
	readonly onFailed: (error: unknown) => void
	readonly onFinished: () => void
} & (
	| { readonly create: CreateTaskOptions; readonly task?: never }
	| { readonly task: TaskHandle; readonly create?: never }
)

/** CLI copy of the SDK Agent tool's ownership boundary. */
async function runBlockingAgentTask(
	input: BlockingAgentTaskInput,
): Promise<{ kind: 'completed'; handle: TaskHandle } | { kind: 'yielded'; handle: TaskHandle }> {
	const { gateway, signal } = input
	signal.throwIfAborted()

	let handle: TaskHandle | undefined
	let cancellationRequested = false
	let taskCancellationAttempted = false
	const wakeController = new AbortController()
	let rejectAbort: (reason: unknown) => void = () => {}
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject
	})
	const cancel = (task: TaskHandle): void => {
		if (taskCancellationAttempted) return
		taskCancellationAttempted = true
		try {
			gateway.cancelTask(task.taskId, 'parent')
		} catch {
			// The parent cancellation remains the caller-visible authority. A
			// scheduler's secondary cancellation refusal must not replace it.
		}
	}
	const onAbort = (): void => {
		cancellationRequested = true
		if (handle) cancel(handle)
		rejectAbort(signal.reason)
	}

	signal.addEventListener('abort', onAbort, { once: true })
	if (signal.aborted) onAbort()
	const creation =
		input.create === undefined ? Promise.resolve(input.task) : gateway.createTask(input.create)
	creation.catch(() => {})

	try {
		handle = await Promise.race([creation, aborted])
		if (cancellationRequested || signal.aborted) {
			cancel(handle)
			signal.throwIfAborted()
		}
		input.onCreated(handle)
		input.completionInbox.launched(handle.taskId)
		const completion = gateway.waitForTask(handle.taskId).then(
			(completed) => {
				try {
					input.onSettled(completed)
				} finally {
					input.onFinished()
				}
				return { kind: 'completed' as const, handle: completed }
			},
			(error) => {
				try {
					input.onFailed(error)
				} finally {
					input.onFinished()
				}
				throw error
			},
		)
		if (input.background && !isTerminalAgentTaskState(handle.state)) {
			// The observer retains activity/definition cleanup after this invocation
			// returns. Parent release still owns cancellation and the tree budget.
			completion.catch(() => {})
			input.completionInbox.expect(handle.taskId)
			return { kind: 'yielded', handle }
		}
		const inbound = input
			.waitForInbound?.(wakeController.signal)
			.then(() => ({ kind: 'inbound' as const }))
		const outcome = await Promise.race(
			inbound ? [completion, aborted, inbound] : [completion, aborted],
		)
		const current = gateway.getTask(handle.taskId)
		if (outcome.kind === 'completed' || (current && isTerminalAgentTaskState(current.state))) {
			input.completionInbox.claim(handle.taskId)
			return outcome.kind === 'completed' ? outcome : await completion
		}
		// Only the wait has ended. Parent runtime ownership, token reservations and
		// the completion observer all outlive this tool invocation's local signal.
		input.completionInbox.expect(handle.taskId)
		return { kind: 'yielded', handle: current ?? handle }
	} catch (error) {
		if (handle) cancel(handle)
		throw error
	} finally {
		if (!handle && cancellationRequested) {
			void creation.then(cancel, () => {})
		}
		signal.removeEventListener('abort', onAbort)
		wakeController.abort()
	}
}

function agentTaskOutcome(task: TaskHandle): string {
	const run = task.result
	if (run?.status && run.status !== 'completed') return run.status
	if (task.state === 'completed' && run?.stopReason && run.stopReason !== 'end_turn')
		return 'incomplete'
	return task.state
}

/** Lifecycle completion is not proof the requested task finished successfully. */
function completedAgentResult(completed: TaskHandle): ToolResult {
	const run = completed.result
	const status = agentTaskOutcome(completed)
	const succeeded = status === 'completed'
	const value = run?.structuredOutput ?? run?.result
	let resultText =
		typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
	if (!resultText && run?.stopReason && run.stopReason !== 'end_turn') {
		// A hard limit can stop between tool rounds without setting Run.result.
		// Keep the child's last visible statement, never its reasoning or tool data.
		const partial = [...run.messages]
			.reverse()
			.find(
				(message) =>
					message.role === 'assistant' &&
					typeof message.content === 'string' &&
					message.content.trim().length > 0,
			)?.content
		if (typeof partial === 'string') resultText = partial
	}
	const stopNote =
		run?.stopReason && run.stopReason !== 'end_turn'
			? `Sub-agent run ended with stop reason "${run.stopReason}". Output may be partial; this does not establish task completion.\n\n`
			: ''
	// ToolResult.data is host metadata, not necessarily model-visible content.
	// Keep the handle and terminal status separate from arbitrary child output
	// (which may itself contain UUIDs or text such as "Task 1").
	const output = `task_id: ${completed.taskId}\nstatus: ${status}\n\nAgent result:\n${stopNote}${resultText || '(sub-agent returned no text)'}`
	return {
		success: succeeded,
		output,
		...(!succeeded
			? {
					error: `Sub-agent ${completed.agentId} ${status}: ${run?.lastError ?? ''}\n${output}`,
				}
			: {}),
		data: {
			task_id: completed.taskId,
			state: completed.state,
			status,
			...(run?.stopReason ? { stop_reason: run.stopReason } : {}),
		},
	}
}

/**
 * Build an agent definition with the given id + persona (system prompt). Used
 * for the static `general-purpose` agent and for each dynamically-defined
 * specialist the model creates via the `Agent` tool's `role` argument.
 */
function buildDefinition(
	id: string,
	description: string,
	systemPrompt: string,
	opts: SubagentRuntimeOptions,
	/** This definition's own roster; absent means the parent's working set. */
	tools: () => ToolRegistryContract = opts.buildTools,
	/** This definition's model; absent means the session's. */
	model: string = opts.model,
	selection?: DelegatedModel,
): AgentDefinition {
	const agent = new ReactiveAgent({
		id,
		name: id,
		version: '1.0.0',
		category: 'general',
		description,
	})
	// A specialist persona is layered on top of the anti-fabrication base so a
	// dynamic role can't opt out of the "don't invent results" guardrails.
	//
	const base =
		systemPrompt === SUBAGENT_PROMPT ? SUBAGENT_PROMPT : `${systemPrompt}\n\n${SUBAGENT_PROMPT}`
	return {
		info: {
			id,
			name: id,
			version: '1.0.0',
			category: 'general',
			description,
			tools: [],
			defaults: { model, tokenBudget: opts.tokenBudget ?? 0 },
		},
		// ReactiveAgent is Agent<ReactiveAgentConfig,…>; the registry stores the
		// erased Agent<BaseAgentConfig,…>. configBuilder supplies the richer config.
		typedAgent: agent as unknown as CoreAgent<BaseAgentConfig, BaseAgentResult>,
		configBuilder: async (options): Promise<ReactiveAgentConfig> => {
			// Resolved HERE, per child, rather than captured once for the session:
			// what day it is and which branch is checked out can both have changed
			// since the parent started, and a sub-agent asserting the stale answer
			// is worse than one that was never told.
			const environment = opts.readEnvironment ? await opts.readEnvironment() : null
			// AgentManager supplies the actual parent run before it stamps the child's
			// own Session ID. All delegated work shares that invoking conversation's
			// upstream billing session, even after the TUI moves to another one.
			const parent = options.parentRunId
				? await opts.resolveParent(asRunId(options.parentRunId))
				: undefined
			return {
				model: options.model ?? model,
				tokenBudget: options.tokenBudget ?? opts.tokenBudget ?? 0,
				timeoutMs: options.timeoutMs ?? CLI_INTERACTIVE_RUN_TIMEOUT_MS,
				maxIterations: 40,
				provider: await opts.buildProvider(parent?.sessionId, selection),
				...(selection?.effort ? { effort: selection.effort } : {}),
				tools: tools(),
				systemPrompt: environment ? `${base}\n\n${environment}` : base,
				...(opts.projectInstructionContext
					? { projectInstructionContext: opts.projectInstructionContext() }
					: {}),
				...(opts.authorizationGate ? { authorizationGate: opts.authorizationGate } : {}),
				...(opts.sandboxProvider ? { sandboxProvider: opts.sandboxProvider } : {}),
				...(opts.sandboxProvider && opts.sandboxWorkspace
					? { sandbox: { workspace: opts.sandboxWorkspace } }
					: {}),
				...(opts.sandboxTeardownTimeoutMs !== undefined
					? { sandboxTeardownTimeoutMs: opts.sandboxTeardownTimeoutMs }
					: {}),
				...(opts.pathBuilder ? { pathBuilder: opts.pathBuilder } : {}),
			}
		},
	}
}
