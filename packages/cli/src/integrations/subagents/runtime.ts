/**
 * Sub-agent runtime: the model delegates work via an `Agent` tool that can
 * DEFINE a specialist on the fly — pass a `role` (the persona / system prompt)
 * and namzu spins up a fresh sub-agent with that role at runtime, no
 * pre-registered definition needed. Omit `role` for a general-purpose one.
 * The call blocks until the child finishes and its final text returns as the
 * tool result, so a delegation surfaces in the transcript as a normal
 * `⏺ Agent(...)` call.
 *
 * The runtime is fully self-contained: a dedicated in-memory session/thread
 * store backs the AgentManager, so sub-agent bookkeeping never touches the
 * CLI's on-disk `/resume` conversation store.
 */

import {
	type ActorRef,
	type AgentDefinition,
	AgentManager,
	AgentRegistry,
	type AgentTaskContext,
	type AuthorizationGateConfig,
	type BaseAgentConfig,
	type BaseAgentResult,
	type Agent as CoreAgent,
	type CreateTaskOptions,
	DefaultCapacityValidator,
	InMemorySessionStore,
	InMemoryTopicStore,
	type LLMProvider,
	LocalTaskScheduler,
	type PathBuilder,
	type ProjectInstructionContext,
	ReactiveAgent,
	type ReactiveAgentConfig,
	type ResumeHandler,
	RunCancelled,
	type RunEvent,
	type SandboxProvider,
	SessionSummaryMaterializer,
	type TaskHandle,
	type TaskScheduler,
	type ToolContext,
	type ToolDefinition,
	type ToolRegistryContract,
	TopicManager,
	WorkspaceBackendRegistry,
	asRunId,
	asSummaryId,
	asTenantId,
	asUserId,
	defineTool,
	mcpJsonSchemaToZod,
} from '@namzu/sdk'

import { NAMZU_WORKING_DOCTRINE } from '../../context/doctrine.js'
import {
	MAX_AGENT_ACTIVITY_LABEL_CODE_UNITS,
	MAX_AGENT_PHASE_ORDER,
	SubagentActivityMonitor,
	type SubagentActivitySource,
} from './activity.js'
import { CLI_INTERACTIVE_RUN_TIMEOUT_MS } from './policy.js'

export const GENERAL_PURPOSE_SUBAGENT = 'general-purpose'

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

export interface SubagentRuntimeOptions {
	readonly cwd: string
	readonly model: string
	/** Durable layout for child runs; omitted preserves the SDK default. */
	readonly pathBuilder?: PathBuilder
	/** Root every child allocation at the session workspace or a fresh temp tree. */
	readonly sandboxWorkspace?: 'working-directory' | 'ephemeral'
	/** Construct a fresh provider for the sub-agent (current credential). */
	readonly buildProvider: () => LLMProvider
	/** Build the sub-agent's tool registry (its own working set). */
	readonly buildTools: () => ToolRegistryContract
	readonly authorizationGate?: AuthorizationGateConfig
	/**
	 * Resolve the interactive authority owned by the parent run that invoked
	 * the Agent tool. Absent means the child has no human review channel.
	 */
	readonly resolveResumeHandler?: (runId: ToolContext['runId']) => ResumeHandler | undefined
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
}

export interface SubagentRuntime {
	readonly gateway: TaskScheduler
	readonly agentTool: ToolDefinition
	readonly allowedAgentIds: readonly string[]
	/** Live, bounded observation of children created by this CLI session. */
	readonly activity: SubagentActivitySource
	/** Stop every child still owned by this parent session. Idempotent. */
	close(): Promise<void>
}

/** A delegated run may never inherit the SDK's headless auto-approval fallback. */
const refuseUnownedChildReview: ResumeHandler = async () => ({
	action: 'abort',
	reason: 'The parent run no longer owns an interactive review channel for this sub-agent.',
})

/**
 * Stand up the AgentManager + gateway + `Agent` tool. Returns the tool to
 * register on the parent and the gateway to pass to `query({ taskGateway })`.
 */
export async function createSubagentRuntime(
	opts: SubagentRuntimeOptions,
): Promise<SubagentRuntime> {
	const tenantId = asTenantId('tnt_namzu-cli')
	const store = new InMemorySessionStore()
	const topicStore = new InMemoryTopicStore()

	const userActor: ActorRef = {
		kind: 'user',
		userId: asUserId('usr_namzu'),
		tenantId,
	}
	const project = await store.createProject({ tenantId, name: 'namzu-cli' }, tenantId)
	const thread = await topicStore.createTopic(
		{ projectId: project.id, title: 'namzu-cli' },
		tenantId,
	)
	// No workspace gate here, and that is a finding rather than an omission.
	//
	// A direct `createSession` bypasses `requireOpenProject`, which is why the
	// CLI's persistent conversation store now calls it explicitly. This site is
	// the other shape: the store is a fresh `InMemorySessionStore` built four
	// lines up, the project was created two lines up, and neither outlives this
	// runtime — so the id can never be one an owner has closed. A gate on a path
	// that always creates its own project checks a condition that cannot be
	// false, and a check that cannot fail teaches the next reader nothing except
	// that gates here are decoration.
	//
	// The trigger to add one is the day this store is replaced by a persistent
	// one, or the project id starts arriving from a caller.
	const parentSession = await store.createSession(
		{ topicId: thread.id, projectId: project.id, currentActor: userActor },
		tenantId,
	)
	await store.updateSession({ ...parentSession, status: 'active' }, tenantId)

	let summaryCounter = 0
	const materializer = new SessionSummaryMaterializer({
		store,
		generateSummaryId: () => asSummaryId(`sum_namzu_${++summaryCounter}`),
	})

	const registry = new AgentRegistry()
	registry.register(
		buildDefinition(
			GENERAL_PURPOSE_SUBAGENT,
			'A general-purpose sub-agent.',
			SUBAGENT_PROMPT,
			opts,
		),
	)

	const topicManager = new TopicManager({ topicStore, sessionStore: store })
	const manager = new AgentManager(
		registry,
		{ childTimeoutMs: CLI_INTERACTIVE_RUN_TIMEOUT_MS },
		{
			sessionStore: store,
			summaryMaterializer: materializer,
			workspaceRegistry: new WorkspaceBackendRegistry(),
			capacity: new DefaultCapacityValidator(store),
			topicManager,
		},
	)

	const taskContext: AgentTaskContext = {
		parentRunId: asRunId('run_namzu-cli'),
		parentAgentId: 'namzu',
		parentAbortController: new AbortController(),
		depth: 0,
		budgetTracker: { total: 1_000_000, remaining: 1_000_000 },
		tenantId,
		topicId: thread.id,
		sessionId: parentSession.id,
		projectId: project.id,
		parentActor: userActor,
	}

	const gateway = new LocalTaskScheduler(manager, taskContext, opts.onEvent)
	const activity = new SubagentActivityMonitor()

	// Dynamic `Agent` tool: the model passes an optional `role` (the persona /
	// system prompt) and we register + spawn a fresh specialist for it at call
	// time — no pre-defined agent file needed. Omit `role` → general-purpose.
	let dynCounter = 0
	const agentTool = defineTool({
		name: 'Agent',
		description:
			'Delegate a self-contained task to a sub-agent and get its result back (BLOCKING). ' +
			'Define the specialist inline with `role` — a system prompt describing who the sub-agent ' +
			'is and how to behave (e.g. "You are a security auditor; flag vulnerabilities and rate severity"). ' +
			'Omit `role` for a general-purpose sub-agent. The sub-agent runs in its own context with its own ' +
			'tools and cannot see this conversation — put everything it needs in `prompt`. Call this multiple ' +
			'times in one response to run specialists in parallel. When coordinating several specialists, give ' +
			'them the same `workflow` label and an explicit `phase` plus `phase_order` so the operator can follow ' +
			'the work in the agent cockpit. These fields are display annotations only; they do not create ' +
			'dependencies, barriers, or serial execution.',
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
			const { description, prompt, role, workflow, phase, phase_order } = input as {
				description: string
				prompt: string
				role?: string
				workflow?: string
				phase?: string
				phase_order?: number
			}
			let agentId = GENERAL_PURPOSE_SUBAGENT
			const persona = typeof role === 'string' ? role.trim() : ''
			const dynamic = persona.length > 0
			if (dynamic) {
				agentId = `dyn-${++dynCounter}`
				registry.register(buildDefinition(agentId, `Dynamic specialist: ${agentId}`, persona, opts))
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
				...(Object.keys(context.env ?? {}).length > 0 ? { env: context.env } : {}),
				resumeHandler,
			}
			try {
				const completed = await runBlockingAgentTask({
					gateway,
					signal: context.abortSignal,
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
				tracker.settle(completed)
				const runStatus = completed.result?.status
				const succeeded =
					completed.state === 'completed' && (runStatus === undefined || runStatus === 'completed')
				const resultText =
					typeof completed.result?.result === 'string'
						? completed.result.result
						: completed.result?.result !== undefined
							? JSON.stringify(completed.result.result)
							: ''
				if (!succeeded) {
					return {
						success: false,
						output: '',
						error: `Sub-agent ${agentId} ${completed.state}: ${completed.result?.lastError ?? resultText ?? '(no detail)'}`,
					}
				}
				return {
					success: true,
					output: resultText || '(sub-agent returned no text)',
				}
			} catch (error) {
				tracker.fail(error)
				throw error
			} finally {
				// A per-call dynamic specialist is single-use — drop its definition
				// (and retained persona string) so long sessions don't leak `dyn-N`
				// registrations whether the task succeeded, failed, or threw.
				if (dynamic) registry.unregister(agentId)
			}
		},
	})

	let closePromise: Promise<void> | undefined
	const close = (): Promise<void> => {
		if (closePromise) return closePromise
		closePromise = Promise.resolve().then(() => {
			// This controller is the parent of every child the manager creates.
			// Abort it before disposing bookkeeping so a live child keeps the
			// structured reason even if its blocking tool wait already detached.
			if (!taskContext.parentAbortController.signal.aborted) {
				taskContext.parentAbortController.abort(new RunCancelled('parent'))
			}
			manager.dispose()
			activity.close()
		})
		return closePromise
	}

	return {
		gateway,
		agentTool,
		allowedAgentIds: [GENERAL_PURPOSE_SUBAGENT],
		activity,
		close,
	}
}

interface BlockingAgentTaskInput {
	readonly gateway: TaskScheduler
	readonly signal: AbortSignal
	readonly create: CreateTaskOptions
}

/** CLI copy of the SDK Agent tool's ownership boundary. */
async function runBlockingAgentTask(input: BlockingAgentTaskInput): Promise<TaskHandle> {
	const { gateway, signal } = input
	signal.throwIfAborted()

	let handle: TaskHandle | undefined
	let cancellationRequested = false
	let taskCancellationAttempted = false
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
	const creation = gateway.createTask(input.create)
	creation.catch(() => {})

	try {
		handle = await Promise.race([creation, aborted])
		if (cancellationRequested || signal.aborted) {
			cancel(handle)
			signal.throwIfAborted()
		}
		const completed = await Promise.race([gateway.waitForTask(handle.taskId), aborted])
		return completed
	} catch (error) {
		if (handle) cancel(handle)
		throw error
	} finally {
		if (!handle && cancellationRequested) {
			void creation.then(cancel, () => {})
		}
		signal.removeEventListener('abort', onAbort)
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
			defaults: { model: opts.model, tokenBudget: 200_000 },
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
			return {
				model: options.model ?? opts.model,
				tokenBudget: options.tokenBudget ?? 200_000,
				timeoutMs: options.timeoutMs ?? CLI_INTERACTIVE_RUN_TIMEOUT_MS,
				maxIterations: 40,
				provider: opts.buildProvider(),
				tools: opts.buildTools(),
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
